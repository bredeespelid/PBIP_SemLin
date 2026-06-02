# Security Policy

## Scope

PBIP Documenter is a **client-side single-page application** that runs entirely in your browser using the File System Access API. No data, files, or credentials are ever uploaded or transmitted — all parsing happens locally.

Vulnerabilities that apply to this project:

- XSS via maliciously crafted TMDL / M expression / PBIR JSON content that could execute code when parsed or rendered
- File System Access API misuse that could access paths beyond the user-selected folder
- Dependency vulnerabilities in any future npm / CDN scripts added to the project
- Content Security Policy gaps

**Out of scope:**

- Issues that require the attacker to control the PBIP project folder that the user intentionally opened (local file trust boundary)

