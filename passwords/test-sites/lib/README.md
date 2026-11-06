# Vendored browser libraries

Used only by the `framework-react-*` and `framework-vue-*` fixtures. Unmodified copies, so
the fixtures need no network beyond the local server.

| File | Package | Version | Licence | Source |
| --- | --- | --- | --- | --- |
| `react.production.min.js` | react | 18.3.1 | MIT | `frontend/node_modules/react/umd/` |
| `react-dom.production.min.js` | react-dom | 18.3.1 | MIT | `frontend/node_modules/react-dom/umd/` |
| `vue.global.prod.js` | vue | 3.5.45 | MIT | `dist/` of the `vue@3.5.45` npm tarball |

`vue.global.prod.js` is the full build, including the template compiler the fixtures rely on.
React 19 removed UMD builds, so stay on 18.x unless the fixtures are rewritten.
