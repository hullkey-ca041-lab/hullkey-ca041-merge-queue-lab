#!/usr/bin/env node
// CA-041. Classify the exact base/head diff and, in evaluate mode, verify every
// branch-protected check required by the selected lane. The allowlist and fail
// rules implement HARN-01.pull_request_scope_gate; update only with a matching
// control amendment.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const CONFIG_PATH = '.github/records-lane.json'
const ALWAYS_REQUIRED = [
  ['scope-classification', 'CI_STATUS_CHANGES'],
  ['repository-boundary', 'CI_STATUS_REPOSITORY_BOUNDARY'],
  ['build', 'CI_STATUS_BUILD'],
  ['rls-test-pairing', 'CI_STATUS_RLS_TEST_PAIRING'],
  ['test-write-protection', 'CI_STATUS_TEST_WRITE_PROTECTION'],
]
const FULL_ONLY = [
  ['db-isolation', 'CI_STATUS_DB_ISOLATION'],
  ['accessibility', 'CI_STATUS_ACCESSIBILITY'],
]

function allowedPath(path) {
  if (path === 'Post-MVP Backlog.md') return true
  return /^backlog\/(?:docs\/sessions|tasks)\/(?:[^/]+\/)*[^/]+\.md$/.test(path)
}

function selectLane(paths, enabled) {
  return paths.length > 0 && paths.every(allowedPath) && enabled ? 'records-only' : 'full'
}

function parseNameStatus(buffer) {
  let decoded
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
  catch { throw new Error('git diff produced a path that cannot be represented as UTF-8; refusing an incomplete path report') }
  const fields = decoded.split('\0')
  if (fields.at(-1) === '') fields.pop()
  const paths = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]
    if (!/^(?:A|C\d+|D|M|R\d+|T|U|X|B)$/.test(status)) {
      throw new Error(`unrecognised or incomplete git diff status: ${JSON.stringify(status)}`)
    }
    const count = /^[RC]/.test(status) ? 2 : 1
    if (i + count > fields.length) throw new Error(`incomplete path data for ${status}`)
    for (let n = 0; n < count; n++) {
      const path = fields[i++]
      if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.')) {
        throw new Error(`invalid or incomplete repository-relative path: ${JSON.stringify(path)}`)
      }
      paths.push(path)
    }
  }
  if (paths.length === 0) throw new Error('the exact base/head diff has no changed paths')
  return paths
}

function readLaneEnabled(base) {
  try {
    execFileSync('git', ['cat-file', '-e', `${base}:${CONFIG_PATH}`], { stdio: 'ignore' })
  } catch {
    // A base predating the CA-041 toggle is the disabled state, never permission
    // to skip checks. Once present, malformed configuration is a gate failure.
    return false
  }
  const raw = execFileSync('git', ['show', `${base}:${CONFIG_PATH}`], { encoding: 'utf8' })
  const config = JSON.parse(raw)
  if (config.schemaVersion !== 1 || typeof config.enabled !== 'boolean' || config.requiredGateCheck !== 'pull-request-scope-gate') {
    throw new Error(`${CONFIG_PATH} at the exact base revision is invalid`)
  }
  return config.enabled
}

function classify(base, head) {
  if (!/^[0-9a-f]{40}$/i.test(base) || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error('exact base and head revisions must both be full 40-character commit SHAs')
  }
  execFileSync('git', ['cat-file', '-e', `${base}^{commit}`])
  execFileSync('git', ['cat-file', '-e', `${head}^{commit}`])
  const paths = parseNameStatus(execFileSync('git', ['diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', base, head]))
  const eligible = paths.every(allowedPath)
  const enabledAtBase = readLaneEnabled(base)
  return {
    base,
    head,
    completePathSet: true,
    changedPaths: paths,
    recordsOnlyEligible: eligible,
    recordsLaneEnabledAtBase: enabledAtBase,
    lane: selectLane(paths, enabledAtBase),
    gateCheck: 'pull-request-scope-gate',
  }
}

function evaluate(scope, statuses = process.env) {
  const results = {}
  const required = [...ALWAYS_REQUIRED, ...(scope.lane === 'full' ? FULL_ONLY : [])]
  for (const [name, envName] of ALWAYS_REQUIRED) {
    results[name] = statuses[envName] || 'absent'
  }
  for (const [name, envName] of FULL_ONLY) {
    results[name] = statuses[envName] || 'absent'
  }
  const failures = []
  if (scope.lane === 'records-only') {
    for (const [name, envName] of FULL_ONLY) {
      const result = statuses[envName] || 'absent'
      if (!['success', 'skipped'].includes(result)) failures.push(`${name} must be success or skipped on records-only lane; got ${result}`)
    }
  }
  for (const [name, envName] of required) {
    if (statuses[envName] !== 'success') failures.push(`${name} is required and must pass; got ${results[name]}`)
  }
  return {
    ...scope,
    requiredSensors: required.map(([name]) => name),
    sensorResults: results,
    gateResult: failures.length ? 'failure' : 'success',
    failures,
  }
}

function selfTest() {
  const cases = [
    ['root allowlisted file', ['Post-MVP Backlog.md'], true],
    ['session at allowlist root', ['backlog/docs/sessions/S-0001.md'], true],
    ['nested session', ['backlog/docs/sessions/archive/S-0001.md'], true],
    ['task at allowlist root', ['backlog/tasks/T-0001.md'], true],
    ['nested task', ['backlog/tasks/archive/T-0001.md'], true],
    ['root file name is exact', ['docs/Post-MVP Backlog.md'], false],
    ['case-sensitive suffix', ['backlog/tasks/T-0001.MD'], false],
    ['code path', ['src/App.tsx'], false],
    ['mixed records and code', ['backlog/tasks/T-0001.md', 'src/App.tsx'], false],
    ['configuration path', ['.github/workflows/ci.yml'], false],
    ['unknown path', ['new-area/notes.md'], false],
    ['rename requires both names allowed', ['backlog/tasks/T-old.md', 'src/T-new.md'], false],
    ['rename inside allowlist', ['backlog/tasks/T-old.md', 'backlog/tasks/T-new.md'], true],
  ]
  let failed = 0
  for (const [name, paths, expected] of cases) {
    const actual = paths.every(allowedPath)
    const ok = actual === expected
    console.log(`${ok ? 'ok' : 'FAIL'} ${name}: ${actual}`)
    if (!ok) failed++
  }
  const disabledStaysFull = selectLane(['Post-MVP Backlog.md'], false) === 'full'
  console.log(`${disabledStaysFull ? 'ok' : 'FAIL'} eligible records stay full while lane is disabled`)
  if (!disabledStaysFull) failed++
  const enabledExactRecords = selectLane(['backlog/docs/sessions/S-0001.md'], true) === 'records-only'
  console.log(`${enabledExactRecords ? 'ok' : 'FAIL'} enabled exact allowlist selects records-only`)
  if (!enabledExactRecords) failed++
  const enabledMixedStaysFull = selectLane(['backlog/tasks/T-0001.md', 'src/App.tsx'], true) === 'full'
  console.log(`${enabledMixedStaysFull ? 'ok' : 'FAIL'} enabled mixed changes stay full`)
  if (!enabledMixedStaysFull) failed++
  const rename = parseNameStatus(Buffer.from('R100\0backlog/tasks/T-old.md\0backlog/tasks/T-new.md\0'))
  if (rename.length !== 2 || !rename.every(allowedPath)) { console.log('FAIL rename status parsing'); failed++ }
  else console.log('ok rename status parsing: both paths retained')
  try { parseNameStatus(Buffer.from('R100\0backlog/tasks/T-old.md\0')) ; console.log('FAIL incomplete rename accepted'); failed++ }
  catch { console.log('ok incomplete rename rejected') }
  try { parseNameStatus(Buffer.from('')) ; console.log('FAIL empty path set accepted'); failed++ }
  catch { console.log('ok empty path set rejected') }
  const allGreen = Object.fromEntries([...ALWAYS_REQUIRED, ...FULL_ONLY].map(([, envName]) => [envName, 'success']))
  const fullScope = { lane: 'full' }
  const fullPass = evaluate(fullScope, allGreen).gateResult === 'success'
  console.log(`${fullPass ? 'ok' : 'FAIL'} full lane requires every sensor to pass`)
  if (!fullPass) failed++
  const fullSkipped = evaluate(fullScope, { ...allGreen, CI_STATUS_DB_ISOLATION: 'skipped' }).gateResult === 'failure'
  console.log(`${fullSkipped ? 'ok' : 'FAIL'} full lane rejects skipped database isolation`)
  if (!fullSkipped) failed++
  const fullAbsent = evaluate(fullScope, { ...allGreen, CI_STATUS_ACCESSIBILITY: 'absent' }).gateResult === 'failure'
  console.log(`${fullAbsent ? 'ok' : 'FAIL'} full lane rejects absent accessibility`)
  if (!fullAbsent) failed++
  const recordsScope = { lane: 'records-only' }
  const recordsSkip = evaluate(recordsScope, { ...allGreen, CI_STATUS_DB_ISOLATION: 'skipped', CI_STATUS_ACCESSIBILITY: 'skipped' }).gateResult === 'success'
  console.log(`${recordsSkip ? 'ok' : 'FAIL'} records lane exempts only database isolation and accessibility`)
  if (!recordsSkip) failed++
  const recordsMissingRequired = evaluate(recordsScope, { ...allGreen, CI_STATUS_BUILD: 'absent' }).gateResult === 'failure'
  console.log(`${recordsMissingRequired ? 'ok' : 'FAIL'} records lane rejects an absent still-required check`)
  if (!recordsMissingRequired) failed++
  console.log(`scope-gate-self-test: ${cases.length + 11 - failed} passed; ${failed} failed`)
  return failed === 0
}

function main() {
  const [mode, ...args] = process.argv.slice(2)
  if (mode === '--self-test') process.exit(selfTest() ? 0 : 1)
  if (!['--classify', '--evaluate'].includes(mode)) throw new Error('usage: ci-scope-gate.mjs --self-test | --classify <base> <head> | --evaluate <base> <head>')
  const [base, head, outputPath] = args
  let report
  try {
    const scope = classify(base || '', head || '')
    report = mode === '--evaluate' ? evaluate(scope) : scope
  } catch (error) {
    const sensorResults = Object.fromEntries([...ALWAYS_REQUIRED, ...FULL_ONLY].map(([name, envName]) => [name, process.env[envName] || 'absent']))
    const failures = [error.message]
    for (const [name, envName] of [...ALWAYS_REQUIRED, ...FULL_ONLY]) {
      if (process.env[envName] !== 'success') failures.push(`${name} must pass while scope is unknown; got ${sensorResults[name]}`)
    }
    report = {
      base: base || null,
      head: head || null,
      completePathSet: false,
      changedPaths: [],
      lane: 'unknown',
      gateCheck: 'pull-request-scope-gate',
      gateResult: 'failure',
      requiredSensors: [...ALWAYS_REQUIRED, ...FULL_ONLY].map(([name]) => name),
      sensorResults,
      failures,
    }
  }
  const encoded = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath) writeFileSync(outputPath, encoded)
  process.stdout.write(encoded)
  if (report.gateResult === 'failure' || !report.completePathSet) process.exit(1)
}

main()
