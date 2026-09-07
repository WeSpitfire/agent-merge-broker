# Trusted local Gate example

This example exercises the Gate features in version 0.14.1. Use Node.js 22+ and Git 2.46+:

```bash
npm install
npm run build
npm run example:gate
```

It creates a temporary repository and local bare remote, commits a reviewed validator and public
signing key on `main`, and registers that local base with refresh disabled. One producer branch
passes; another fails with a nonzero validator status (`7`, or `1` through Windows PowerShell).
It then exports an Ed25519 DSSE attestation,
verifies it outside the repository using the independently selected public key and expected
identities, and previews archival of both records. Signing leaves the candidate commit unchanged;
the result always reports `mergeAuthorized: false`.

No external repository is contacted. The generated private key stays in the temporary Git runtime
directory. The demo removes its temporary directory when it finishes; set `KEEP=1` to retain it for
inspection. In PowerShell, set `$env:KEEP = "1"` before running the command.

The example's key and expected identities come from its own reviewed fixture. In a real consuming
workflow, obtain those trust inputs independently of the submitted attestation. A valid signature
can also describe a rejected or failed validation; check `validationPassed`, not just `verified`.
