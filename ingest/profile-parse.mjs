/**
 * Re-export of the resume parser.
 *
 * The implementation lives at functions/api/_profile-parse.js so the Pages
 * Function can import it. wrangler only bundles what functions/ can reach,
 * and ingest/ is not copied into .deploy -- an import the other way would
 * 500 the profile route the first time a save tried to parse. Tests in
 * ingest/ import this file, which is the path every other ingest test uses.
 */
export {
  DATE_LINE,
  CURRENT_END,
  isHeading,
  linesToParagraphs,
  parseDateLine,
  parseExperience,
  parseResume,
  emptySections,
  normalizeSections,
  mergeSections,
  moveItem,
  acceptItem,
  itemFingerprint,
  stripContact,
  publicView,
  personJsonLd,
  pragmaColumns,
  isDuplicateColumnError,
  ensureProfileColumns,
  sectionsFromParse
} from '../functions/api/_profile-parse.js';
