/**
 * The email-pattern derivation, and the cases that must refuse to answer.
 *
 * This module's output ends up next to a real person's name as something Brian
 * might send mail to, so the failure that matters is not "no pattern found" but
 * "a confident pattern derived from nothing". Every floor below has a case that
 * trips it.
 *
 * Run: node ingest/test-email-pattern.mjs
 */

import {
  asciiFold, localPartShape, nameParts, addressFor, derivePattern
} from './email-pattern.mjs';

let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(name).padEnd(62)} ${detail ?? ''}`);
};
const eq = (name, got, want) =>
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

/* ------------------------------------------------------------- ascii fold -- */

eq('an accented name folds to the ascii a mail system uses',
  asciiFold('Manuel de la Peña'), 'manuel de la pena');
eq('a plain name is unchanged apart from case', asciiFold('Mat Velloso'), 'mat velloso');
eq('empty input folds to empty', asciiFold(undefined), '');

/* ----------------------------------------------------------------- shapes -- */

eq('a dotted local part is first.last', localPartShape('pawel.gronowski'), 'first.last');
eq('an initial and a surname is f.last', localPartShape('p.gronowski'), 'f.last');
eq('an underscore local part is first_last', localPartShape('pawel_gronowski'), 'first_last');
eq('a bare word is reported as first', localPartShape('pawel'), 'first');
eq('a digit-bearing local part is other', localPartShape('pawel99'), 'other');
eq('a three-part local part is other', localPartShape('a.b.c'), 'other');
eq('an empty local part is other', localPartShape(''), 'other');

/* ------------------------------------------------------------ name splits -- */

eq('two tokens split cleanly', nameParts('Mat Velloso'),
  { first: 'mat', last: 'velloso', ambiguous: false });
eq('a hyphenated given name loses the hyphen and is flagged ambiguous',
  nameParts('Jean-Laurent de Morlhon'), { first: 'jeanlaurent', last: 'morlhon', ambiguous: true });
eq('an accented surname folds', nameParts('Manuel de la Peña'),
  { first: 'manuel', last: 'pena', ambiguous: true });
/* A single token cannot produce first.last, and inventing a surname would be
   the exact failure this file exists to prevent. */
eq('a single-token name yields nothing rather than a guess', nameParts('Madonna'), null);
eq('an empty name yields nothing', nameParts(''), null);

/* --------------------------------------------------------------- addresses -- */

eq('first.last applied to a name', addressFor('first.last', 'Mat Velloso', 'docker.com'),
  { address: 'mat.velloso@docker.com', ambiguous: false });
eq('first applied to a name', addressFor('first', 'Mat Velloso', 'getjerry.com'),
  { address: 'mat@getjerry.com', ambiguous: false });
eq('f.last applied to a name', addressFor('f.last', 'Mat Velloso', 'docker.com'),
  { address: 'm.velloso@docker.com', ambiguous: false });
eq('a leading @ on the domain is tolerated',
  addressFor('first.last', 'Mat Velloso', '@docker.com'),
  { address: 'mat.velloso@docker.com', ambiguous: false });
eq('an ambiguous name carries the flag through to the address',
  addressFor('first.last', 'Jean-Laurent de Morlhon', 'docker.com'),
  { address: 'jeanlaurent.morlhon@docker.com', ambiguous: true });
eq('an unknown shape produces nothing', addressFor('nonsense', 'Mat Velloso', 'docker.com'), null);
eq('a one-token name produces nothing', addressFor('first.last', 'Madonna', 'docker.com'), null);
eq('a missing domain produces nothing', addressFor('first.last', 'Mat Velloso', ''), null);

/* ------------------------------------------------------------- derivation -- */

/* The real docker.com reading, unique addresses only. */
const dockerLike = [
  'pawel.gronowski@docker.com', 'benjamin.grandfond@docker.com', 'craig.osterhout@docker.com',
  'emmanuel.briney@docker.com', 'vincent.damery@docker.com', 'someone.else@docker.com',
  'ci@docker.com'
];
const docker = derivePattern(dockerLike);
check('a consistent employer yields a pattern', docker.ok && docker.shape === 'first.last',
  `${docker.shape} ${docker.agree}/${docker.unique} (${docker.pct}%)`);

/* THE FLOORS. Each of these must refuse. */

const thin = derivePattern(['a.b@x.com', 'c.d@x.com', 'e.f@x.com']);
check('three addresses is below the floor and refuses',
  !thin.ok && /floor is 4/.test(thin.reason), thin.reason);

const mixed = derivePattern([
  'a.b@x.com', 'c.d@x.com', 'eee@x.com', 'fff@x.com', 'ggg@x.com', 'hhh@x.com'
]);
check('a mixed convention refuses rather than picking the bigger half',
  !mixed.ok && /%/.test(mixed.reason), `${mixed.shape} ${mixed.pct}% -- ${mixed.reason}`);

check('no addresses refuses', !derivePattern([]).ok, derivePattern([]).reason);

/* Occurrences must not decide the answer. One person committing many times is
   one data point, and counting rows instead of people is how a whole company's
   convention gets set by whoever is busiest. */
const repeated = derivePattern([
  'busy.person@x.com', 'busy.person@x.com', 'busy.person@x.com', 'busy.person@x.com',
  'busy.person@x.com', 'busy.person@x.com', 'solo@x.com'
]);
check('a repeated address counts once, so this stays below the floor',
  !repeated.ok && repeated.unique === 2, `unique=${repeated.unique} -- ${repeated.reason}`);

/* GitHub's privacy addresses are not employer addresses. */
const noreply = derivePattern([
  '1234+user@users.noreply.github.com', '5678+other@users.noreply.github.com',
  'a.b@x.com', 'c.d@x.com', 'e.f@x.com', 'g.h@x.com'
]);
check('github noreply addresses are excluded from the denominator',
  noreply.ok && noreply.unique === 4, `unique=${noreply.unique}`);

/* The module must never hand back what it read. */
const leaked = JSON.stringify(derivePattern(dockerLike));
check('the result carries no address from the input',
  !/@docker\.com/.test(leaked) && !/gronowski/.test(leaked), leaked.slice(0, 80));

console.log(bad
  ? `\n${bad} FAILED`
  : '\nthe pattern is derived from unique addresses, refuses below its floors, and leaks none of them');
process.exitCode = bad ? 1 : 0;
