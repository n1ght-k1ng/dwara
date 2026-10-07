#!/usr/bin/env node
/**
 * The `dwara` binary, as published.
 *
 * **A side-effect import, not a call to `main()`.** Each package's entry module
 * already ends with `if (isEntryPoint()) await main()`, and once the code is
 * bundled into this file that guard compares `process.argv[1]` against this
 * file's own URL -- which now match. Importing and *also* calling `main()` ran
 * everything twice: `dwara-hook` emitted two JSON decisions on one stdin, which
 * a client would read as a protocol violation, and `dwara doctor` checked every
 * host twice.
 *
 * Found by installing the tarball and running the binaries, not by reading them.
 * A test asserts the single execution, because this is the kind of thing that
 * comes back.
 */
import '@dwara/cli';
