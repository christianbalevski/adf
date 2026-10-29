# ADF compatibility

The ADF schema is a public file-format contract used by other people and
applications. Preserve it. Schema changes are exceptional and justified only
by the most necessary, extreme circumstances; do not introduce them for routine
features or convenience.

Build features with existing ADF systems: files in the existing filesystem,
existing tables, tools, and runtime facilities. Do not add format fields, built-in tables,
schema versions, or migrations when existing facilities can represent the data.
This compatibility boundary includes tool definitions and their input schemas,
not just SQLite tables or format versions. Tools are primitives: introduce a
new tool only for a capability that cannot be composed from existing tools.
Convenience workflows belong in skills, prompts, agent-authored lambdas, ordinary
files, or agent-created local tables. For example, copying a file does not
justify fs_copy when existing file operations compose the behavior.

Persistent investigation state must use these existing capabilities, with no
new built-in investigation tool or investigation-specific runtime injection.
