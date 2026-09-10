import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPage } from "../classify.mjs";

test("redirect to suspended-domain.net is dead", () => {
  const state = classifyPage({
    url: "https://flexgen.zya.me/job/remote-sr-product-manager-platform-growth-scaling",
    finalUrl: "https://www.suspended-domain.net/",
    httpStatus: 200,
    title: "Suspended Domain",
    bodyText: "This domain is suspended",
    hasApplyControl: false
  });
  assert.equal(state, "dead");
});

test("HTTP 410 is dead", () => {
  assert.equal(
    classifyPage({
      url: "https://www.dice.com/job-detail/fb5e78e0-9b5a-462b-9236-3c79de7f0dbd",
      finalUrl: "https://www.dice.com/job-detail/fb5e78e0-9b5a-462b-9236-3c79de7f0dbd",
      httpStatus: 410,
      title: "Gone",
      bodyText: "",
      hasApplyControl: false
    }),
    "dead"
  );
});

test("HTTP 404 is dead", () => {
  assert.equal(
    classifyPage({
      url: "https://example.com/missing",
      finalUrl: "https://example.com/missing",
      httpStatus: 404,
      title: "Not Found",
      bodyText: "not found",
      hasApplyControl: false
    }),
    "dead"
  );
});

test("closed/expired posting copy is dead", () => {
  assert.equal(
    classifyPage({
      url: "https://jobs.example.com/old",
      finalUrl: "https://jobs.example.com/old",
      httpStatus: 200,
      title: "Role",
      bodyText: "This job posting is no longer active and has expired.",
      hasApplyControl: false
    }),
    "dead"
  );
});

test("403 security verification interstitial is wall", () => {
  assert.equal(
    classifyPage({
      url: "https://jobs.gusto.com/postings/example",
      finalUrl: "https://jobs.gusto.com/postings/example",
      httpStatus: 403,
      title: "Performing security verification",
      bodyText: "Performing security verification",
      hasApplyControl: false
    }),
    "wall"
  );
});

test("LinkedIn sign-in wall is wall", () => {
  assert.equal(
    classifyPage({
      url: "https://www.linkedin.com/jobs/view/product-manager-at-1mind-4456171288",
      finalUrl: "https://www.linkedin.com/authwall",
      httpStatus: 200,
      title: "Sign in | LinkedIn",
      bodyText: "Sign in to view this job. Join now or log in.",
      hasApplyControl: false
    }),
    "wall"
  );
});

test("LinkedIn apply button behind a sign-in modal is wall", () => {
  assert.equal(
    classifyPage({
      url: "https://www.linkedin.com/jobs/view/product-manager-at-1mind-4456171288",
      finalUrl: "https://www.linkedin.com/jobs/view/product-manager-at-1mind-4456171288",
      httpStatus: 200,
      title: "1mind hiring Product Manager",
      bodyText: "Sign in to see who you already know. Continue with Google. Sign in with Email. Apply",
      hasApplyControl: true,
      signInModal: true
    }),
    "wall"
  );
});

test("apply control that opens a security verification page is wall", () => {
  assert.equal(
    classifyPage({
      url: "https://startup.jobs/example",
      finalUrl: "https://startup.jobs/example",
      httpStatus: 200,
      title: "Senior Product Manager",
      bodyText: "Apply for this job",
      hasApplyControl: true,
      applyWall: true
    }),
    "wall"
  );
});

test("recaptcha script alone is not a wall when apply is present", () => {
  assert.equal(
    classifyPage({
      url: "https://job-boards.greenhouse.io/gitlab/jobs/8684348002",
      finalUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8684348002",
      httpStatus: 200,
      title: "Senior Product Manager, Growth",
      bodyText: "Apply  Submit application  recaptcha is loaded via script elsewhere",
      hasApplyControl: true,
      hasRecaptchaScript: true
    }),
    "live"
  );
});

test("Ashby apply control is live", () => {
  assert.equal(
    classifyPage({
      url: "https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8",
      finalUrl: "https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8",
      httpStatus: 200,
      title: "Senior Product Manager - Special Projects",
      bodyText: "Apply for this Job",
      hasApplyControl: true
    }),
    "live"
  );
});

/* --- absence of evidence is not death (2026-09-10) ------------------------ */

/* Of twelve rows link-check called dead, FIVE were dead, three were live and
   four were unknowable from the page alone. Two paths returned "dead" without
   any evidence of death, and a wrongly-retired row is one he never sees again. */

test("a navigation that threw is unknown, not dead", () => {
  /* httpStatus 0 means goto() raised. QuinStreet and Pinterest both timed out
     and were called dead; their board API and page text then returned 6,265 and
     7,086 characters of live posting. */
  assert.equal(classifyPage({
    url: "https://x/j", finalUrl: "https://x/j", httpStatus: 0, hasApplyControl: false
  }), "unknown");
});

test("a 200 with no apply control the detector could find is unknown", () => {
  /* Adobe, Capital One and Cisco serve a 148-character Workday shell that
     renders its apply button in JS. */
  assert.equal(classifyPage({
    url: "https://adobe.wd5.myworkdayjobs.com/en-US/x/job/y",
    finalUrl: "https://adobe.wd5.myworkdayjobs.com/en-US/x/job/y",
    httpStatus: 200, title: "Careers", bodyText: "Careers", hasApplyControl: false
  }), "unknown");
});

test("a page that SAYS it is closed is still dead", () => {
  assert.equal(classifyPage({
    url: "https://x/j", finalUrl: "https://x/j", httpStatus: 200,
    bodyText: "This position has been filled", hasApplyControl: false
  }), "dead");
});

test("a 404 and a 410 are still dead", () => {
  for (const httpStatus of [404, 410]) {
    assert.equal(classifyPage({
      url: "https://x/j", finalUrl: "https://x/j", httpStatus, hasApplyControl: false
    }), "dead");
  }
});

test("a parked domain is still dead", () => {
  assert.equal(classifyPage({
    url: "https://flexgen.zya.me/job/x",
    finalUrl: "https://suspended-domain.net/index.php?host=flexgen.zya.me",
    httpStatus: 200, hasApplyControl: false
  }), "dead");
});

test("an apply control is still live, so unknown did not swallow the live case", () => {
  assert.equal(classifyPage({
    url: "https://x/j", finalUrl: "https://x/j", httpStatus: 200, hasApplyControl: true
  }), "live");
});
