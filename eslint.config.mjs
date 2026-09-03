/**
 * The linter exists for one bug class, and it was earned.
 *
 * On 2026-09-03 a fix moved the pay percentile onto the whole queue and used
 * `all`, which index.html declares and ingest/daily.mjs does not. CI died with
 * `ReferenceError: all is not defined` at daily.mjs:213 -- on a line the test
 * written alongside it called correct, because that test asserted the STRING
 * `publishedStarts(all.filter(` was present. It was. A text match cannot see an
 * undefined reference. `no-undef` catches that class everywhere in one pass
 * rather than at the one line somebody thought to check.
 *
 * ONE globals list, covering Node, the browser and Workers together, rather
 * than a block per environment. That is deliberate and it is a trade:
 *
 *   - Half the repo is Node (ingest/, apply/), half is browser (web/), and the
 *     Playwright suites are both at once -- `document` inside a
 *     page.evaluate() callback is correct browser code written in a Node file,
 *     and no file-level rule can tell the two apart. Splitting by directory
 *     reported 117 no-undef errors for `document` in code that was right.
 *   - A lint that is wrong about the code is a lint nobody reads, and an
 *     ignored lint catches nothing at all.
 *   - The cost is that a browser global used by mistake in a Node file is not
 *     flagged. The bug this exists for -- a name that exists in NO environment
 *     -- is still caught, and that is the one that reached production.
 *
 * No stylistic rules on purpose. This repo has no package.json and no
 * committed dependencies, so eslint is installed ad hoc in CI the same way
 * playwright is, and a lint arguing about quotes would be noise.
 *
 * Run: npm install --no-save eslint && npx eslint .
 */

const globals = {
  /* Node */
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', structuredClone: 'readonly',
  /* Shared by Node 18+, the browser and Workers */
  fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  Blob: 'readonly', FormData: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', btoa: 'readonly', atob: 'readonly',
  performance: 'readonly', queueMicrotask: 'readonly',
  /* Browser: web/, and every page.evaluate() callback in the suites */
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly',
  getComputedStyle: 'readonly', matchMedia: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  innerWidth: 'readonly', innerHeight: 'readonly', scrollTo: 'readonly',
  addEventListener: 'readonly', removeEventListener: 'readonly',
  Node: 'readonly', NodeFilter: 'readonly', Element: 'readonly',
  HTMLElement: 'readonly', HTMLButtonElement: 'readonly',
  HTMLInputElement: 'readonly', MutationObserver: 'readonly',
  IntersectionObserver: 'readonly', Image: 'readonly',
  FileReader: 'readonly', CSS: 'readonly', alert: 'readonly',
  /* Cloudflare Pages Functions, under functions/ */
  Response: 'readonly', Request: 'readonly', Headers: 'readonly',
  caches: 'readonly'
};

export default [
  {
    files: ['**/*.mjs', '**/*.js'],
    ignores: [
      'node_modules/**',
      '.deploy/**',
      'backups/**',
      'ingest/out/**',
      'evidence/**',
      'screenshots/**',
      '**/*.local.*'
    ],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      /* The rule this file exists for. */
      'no-undef': 'error',
      /* Its relatives: each is a reference or a write that does nothing at
         runtime, which is the same failure wearing a different name. */
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-obj-calls': 'error',
      'no-unreachable': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        /* An unused catch binding is usually a swallowed error, and this repo
           has swallowed enough of them. Naming it _ says it was deliberate. */
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  }
];
