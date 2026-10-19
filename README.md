# CA-041 isolated merge-queue demonstration lab

This private repository is a disposable, non-production fixture for testing the CA-041 merge-queue policy. It contains no application product code, deploy workflow, deployment environment, or deployment credential. The repository Actions token is read-only.

The scope gate is copied byte-for-byte from HullKey's CA-041 implementation. The default-branch records lane is disabled. A temporary, isolated fixture branch may enable the flag solely to demonstrate records-only status selection; that branch is not HullKey and has no production deployment path.

Lab scenario: repository-boundary skipped on merge_group only.
