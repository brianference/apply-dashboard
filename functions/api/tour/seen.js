/**
 * POST /api/tour/seen
 *
 * Pages Functions maps this file to that URL. The handler lives next to the
 * other write routes so origin, session and bind rules stay in one place.
 */

export { onRequestPost, onRequestOptions, onRequest } from "../tour.js";
