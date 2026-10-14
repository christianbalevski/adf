# Publication evidence and scope

Status: frozen review candidate, NOT ACCEPTED, not activated. Revision 3.1 with final documentation edits.

Gateway SHA256: e17097e5329691abe702f1cb9f4db39b5e520de0a616983de32852ac427336bc.
Runtime dependency: source commit 04beee215def628a51e560ab9ede38307bfcd615 PLUS runtime-gates.patch SHA25677d2d7187b876d13ccf0541e729f9f61873a1df2b40c0631acb03e23675e24ce. Unpatched pin is unsafe for deployment. Guide alignment patch SHA2567ac50d28dc13f09e8f1580a3be990cb00c585d8ebd98bcf8bc7abcd72ec17c0b belongs in the same proposed upstream change.

Runnable evidence, patches and clean-install recipe: hil-final-gates-complete.tar.gz, 526259 bytes, SHA2562f1dde1c7315c5fc4aa269120c02f83adc7a624262db4c1e12c38b6f47c658d6. Run reports/repro/hil-clean-run.sh as documented in reports/final-gates.md. Engineer independently reproduced patched90/90; baseline81/81 characterizes defects, not safety. Sage independent reproduction pending. Current exact gateway with this real-runtime harness supersedes obsolete mock19 tests, per Sage October12 review.

Node20.20.2, npm10.8.2; tracked lock SHA25604e4a6a0ac517871880c0bce50951f5ad43c18b5d65ef961c9d8e47d8f8485c7. Simulated Telegram Bot API and scripted LLM, real ADF runtime/adapter/database. Not live Telegram, Electron IPC/package, multi-process CAS, crash/restart or full TTL validation. Owner bootstrap emptiness remains a historical trust boundary. Installed-runtime compatibility, actual numeric owner binding and harmless live tests are deployment preconditions.

Purpose overlap: Engineer inspected pinned repository; no existing skill overlap. Existing tasks/triggers guide examples overlap and are aligned by the separate guide patch; do not keep unsafe parallel reply handlers. Check latest upstream registry and open PRs again before PR creation; no automatic merges.

Redistribution: MIK grants redistribution of the authored skill; ADF Engineer supplied gateway corrections and runnable tests through its approved worker. Runtime/docs patches retain upstream repository licensing. No real principal ID, bot token or credentials included.
