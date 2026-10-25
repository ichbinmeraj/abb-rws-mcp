# Releasing abb-rws-mcp

How a version of abb-rws-mcp gets to npm and to the MCP Registry. The steps are
written for 0.1.0; a later version follows them with its own numbers. The commands
are for PowerShell on Windows. Run them in the repository's folder.

## Before step 1

- **abb-rws-daemon 0.1.0 is on npm:** `npm view abb-rws-daemon@0.1.0 version` must
  answer `0.1.0`. The README tells people to install it first.
- **The branch is pushed as `release/<version>` and CI is green on it.**
- The working tree is clean (`git status --short` prints nothing).
- **What was tested is written down, and nothing more.** The status line at the top of
  README and the "Tested" and "Not yet" parts of CHANGELOG say what this version was run
  against.
  Change them only after a run of every tool through an MCP host against a live daemon,
  and name exactly the controllers and RobotWare versions of that run.

## Steps

1. **Date the release.** In `CHANGELOG.md` the heading becomes
   `## [0.1.0] - YYYY-MM-DD` with the publish date.

2. **Check the versions agree.** `package.json` `version`, `server.json` `version`
   and `server.json` `packages[0].version` are the same, and `package.json`
   `mcpName` is the `server.json` `name`. The test suite checks this; read it once:

   ```powershell
   npm pkg get version mcpName
   Get-Content server.json
   ```

3. **Build and test from nothing.**

   ```powershell
   Remove-Item -Recurse -Force dist, node_modules
   npm ci
   npm run build
   npm test
   npm run lint
   node scripts/notices.mjs --check
   ```

4. **Read the file list once with your own eyes.**

   ```powershell
   npm pack --dry-run
   ```

   It lists `package.json`, `dist/cli.js`, `LICENSE`, `NOTICE`,
   `THIRD_PARTY_NOTICES.md`, `TRADEMARKS.md`, `README.md` and `CHANGELOG.md`, and
   nothing else.

5. **Commit, push, wait, then tag.** Push the branch. Only when CI on that commit is
   green:

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

6. **Publish to npm.**

   ```powershell
   npm publish --access public
   ```

   `prepack` builds and tests again.

7. **List it in the MCP Registry.** The registry reads `mcpName` from the version
   npm now has, so this step comes after step 6. With
   [mcp-publisher](https://github.com/modelcontextprotocol/registry) installed:

   ```powershell
   mcp-publisher login github
   mcp-publisher publish
   ```

   The login is as the GitHub account that owns the `io.github.ichbinmeraj`
   namespace. If the publish refuses the `$schema` of `server.json` as outdated,
   update `server.json` to the schema it names, commit it, and publish again. Then
   check the listing:

   ```powershell
   curl.exe "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.ichbinmeraj/abb-rws-mcp"
   ```

8. **Afterwards.**
   - On a machine that has never had the package: `npx -y abb-rws-mcp@0.1.0 --version`.
   - `npm deprecate abb-rws-mcp@0.0.1 "placeholder; use 0.1.0 or later"`. The name
     was reserved with a 0.0.1 that has no working command.
   - Merge the release branch into `master`. GitHub shows `master`'s README, and npm's
     page can resolve the README's relative links (CHANGELOG.md,
     THIRD_PARTY_NOTICES.md) against `master`. Until the merge, the repository page
     shows the text from before the release, and those two links do not resolve.
   - A GitHub release for the tag, with the 0.1.0 section of the changelog.

## If something is wrong after publishing

Publish a fixed patch version, with its own `server.json` version, and
`npm deprecate` the bad one. Do not unpublish.
