/**
 * The work shown on the portfolio, with its evidence.
 *
 * Every entry here was verified on 2026-08-27: the live URL returned HTTP 200,
 * the screenshot in ./img was captured from that page on that day, and the
 * description is the repository's own, not a rewrite. Nothing is aspirational
 * and nothing is invented - if a link dies, the entry comes out rather than
 * staying up as a claim nobody can check.
 */

/** @typedef {{slug: string, name: string, url: string, repo: string|null, blurb: string, shot: string}} Project */

/** @type {Project[]} */
export const PROJECTS = [
  {
    slug: "redanvil",
    name: "RedAnvil",
    url: "https://redanvil.pages.dev",
    repo: "https://github.com/brianference/redanvil",
    blurb: "An app factory. One prompt becomes a PRD, then a full-stack app with a database, API and tests, with human review of design and logo and a rule gate that sends the build back when it is not good enough.",
    shot: "./img/redanvil.png"
  },
  {
    slug: "daisydog",
    name: "DaisyDog",
    url: "https://daisydog.org",
    repo: "https://github.com/brianference/daisydog",
    blurb: "A child-safe AI companion. The safety rules were written as acceptance criteria before any feature work started, rather than filtered on afterwards.",
    shot: "./img/daisydog.png"
  },
  {
    slug: "coleramsey",
    name: "Cole Ramsey Music",
    url: "https://coleramseymusic.com",
    repo: null,
    blurb: "An AI music label taken from nothing to two released albums and twenty-six songs, run as release trains with fixed dates for writing, production, artwork and distribution.",
    shot: "./img/coleramsey.png"
  },
  {
    slug: "trip-one",
    name: "Trip One",
    url: "https://trip-one.pages.dev",
    repo: "https://github.com/brianference/trip-one",
    blurb: "Grounded AI trip planner. Real places only, chat refine, maps and weather, with schema-validated generation so the failure mode is less rather than wrong.",
    shot: "./img/trip-one.png"
  },
  {
    slug: "scholarship-one",
    name: "Scholarship One",
    url: "https://scholarship-one.pages.dev",
    repo: "https://github.com/brianference/scholarship-one",
    blurb: "AI scholarship matcher with grounded recommendations, deadlines and an essay coach.",
    shot: "./img/scholarship-one.png"
  },
  {
    slug: "az-planting-calendar",
    name: "AZ Planting Calendar",
    url: "https://az-planting-calendar.pages.dev",
    repo: null,
    blurb: "What to plant now in the Maricopa County low desert, on a half-month timeline. Windows come from UA Cooperative Extension az1005 and frost dates from NOAA 1991-2020 normals, and the assistant answers from that database rather than from general knowledge.",
    shot: "./img/az-planting-calendar.png"
  },
  {
    slug: "quickflight",
    name: "QuickFlight",
    url: "https://quickflight.pages.dev",
    repo: null,
    blurb: "Search the lowest-cost flights for a route and set of dates.",
    shot: "./img/quickflight.png"
  },
  {
    slug: "sushi-finder",
    name: "Sushi Finder",
    url: "https://sushi-finder.pages.dev",
    repo: null,
    blurb: "Worldwide sushi discovery.",
    shot: "./img/sushi-finder.png"
  },
  {
    slug: "pet-sitter",
    name: "Pet Sitter Finder",
    url: "https://pet-sitter-vz1.pages.dev",
    repo: null,
    blurb: "Find and book a pet sitter.",
    shot: "./img/pet-sitter.png"
  },
  {
    slug: "kanban-board",
    name: "FlowBoard",
    url: "https://kanban-board-public.pages.dev",
    repo: "https://github.com/brianference/kanban-board",
    blurb: "Project kanban for makers and teams, with Python and CLI tooling behind the public board.",
    shot: "./img/kanban-board.png"
  }
];
