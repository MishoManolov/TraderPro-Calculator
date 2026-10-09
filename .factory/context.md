# Project context

Purpose: a Manifest V3 Chrome extension that reads buy and rebalance-to-% signals and sizes positions. Plain scripts loaded by the browser: no build step, no bundler, no package.json, no test framework. CLAUDE.md has the module system (a single global TPS namespace, load order from manifest.json) and the non-negotiable constraints: never hardcode a secret, and do not add a build step.

Checks the factory runs: every .js file still parses (node --check). There are no tests, so a change is held to an approved plan first, and the reviewer and the person merging are the checks. shared/classify.js and shared/sizing.js are pure and carry the money maths: explain any change to a calculation in the pull request.

manifest.json (permissions and host permissions) and the publishing files are changed by people only.

Definition of done: all scripts parse and the behaviour described in README.md still holds.
