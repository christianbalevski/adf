// `npm run typecheck`. No entry guard: comparing import.meta.url (a realpath)
// with process.argv[1] skipped every check, exit 0, when started through a
// link or a differently cased drive letter. The function lives in
// typecheck-projects.mjs so tests import it without running it.
import { runTypecheckProjects } from './typecheck-projects.mjs'

process.exitCode = runTypecheckProjects()
