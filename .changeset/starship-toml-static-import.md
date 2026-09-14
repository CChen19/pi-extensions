---
"@narumitw/pi-starship": patch
---

Import the TOML parser instead of resolving it through `createRequire` so settings load under a compiled Pi binary, whose Jiti loader resolves a call-time `require` against the binary's embedded modules rather than the directory the package was installed into. The runtime build now refuses a generated chunk that resolves a package at call time, and the package has the Jiti-loader test its siblings already carry.
