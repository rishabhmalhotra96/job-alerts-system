# Job Alerts System

A security-focused Google Apps Script collector for monitoring bounded public job sources and reviewing matching roles in a private Google Sheet.

## Safety Model

- Runs in `SHADOW` by default and keeps notification delivery release-locked.
- Uses a private, container-bound Sheet and Apps Script project as the access-control boundary.
- Exposes no `doGet` or `doPost` web endpoint.
- Uses `MailApp` only; it does not request Gmail inbox access.
- Stores no applicant data, credentials, cookies, or configurable recipient addresses.
- Restricts requests to reviewed HTTPS hosts with response-size, pagination, retry, and runtime limits.
- Rejects malformed, redirected, oversized, duplicate, or structurally ambiguous source data without inferring closures.
- Neutralizes spreadsheet formulas and escapes rendered email content.

Never commit `.clasp.json`, `.clasprc.json`, generated `dist/` artifacts, runtime logs, Sheet data, or deployment identifiers. These paths are ignored by default.

## Requirements

- Node.js 24 or newer
- A private Google Sheet with a container-bound Apps Script project
- `clasp` for deployment, installed locally or invoked with `npx`

## Development

```sh
npm install
npm run check
```

The validation command runs strict TypeScript checks, the complete Node test suite, and the production build.

Build artifacts are written to `dist/`:

```sh
npm run build
```

Only `dist/Code.js` and `dist/appsscript.json` are intended for Apps Script deployment.

## Local Apps Script Configuration

Create a local `.clasp.json` for your own private Apps Script project. Do not copy another deployment's project, Sheet, or deployment IDs, and do not commit this file.

The reviewed manifest is maintained in `src/appsscript.json`. Review every OAuth scope before deployment. Keep the Sheet and Apps Script project restricted to trusted editors.

## Architecture

- `src/collector.ts`: bounded collection orchestration and source isolation
- `src/sources.ts`: reviewed source catalog and geography policies
- `src/domain.ts`: deterministic matching and normalization
- `src/sheets.ts`: guarded persistence, lifecycle tracking, and outbox state
- `src/runtime.ts`: shadow mode, owner binding, quota, and notification safeguards
- `src/main.ts`: Apps Script entry points and transport integration
- `tests/`: parser, policy, failure-injection, integration, and security coverage

The system uses stable source-owned job identifiers. Closures require repeated validated misses over time; failed or partial sources cannot close jobs.

## Government Evidence

The runtime bundles a reviewed DETE permit-history snapshot for informational matching signals. It does not download government workbooks during collection, and historical permit evidence is not a promise of sponsorship or approval.

To validate a reviewed local workbook:

```sh
npm run dete:evidence -- --input /path/to/workbook.xlsx
```

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Do not post credentials, private resource identifiers, applicant information, or exploit details in public issues.

## License

Licensed under the [MIT License](LICENSE).
