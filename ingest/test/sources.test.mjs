import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGreenhouseJobs } from "../sources/greenhouse.mjs";
import { normalizeLeverJobs } from "../sources/lever.mjs";
import { normalizeAshbyJobs } from "../sources/ashby.mjs";
import { normalizeRemoteOkJobs } from "../sources/remoteok.mjs";
import { normalizeHimalayasJobs } from "../sources/himalayas.mjs";
import { parseRssItems } from "../rss.mjs";
import { normalizeWeWorkRemotelyItems } from "../sources/weworkremotely.mjs";
import { normalizeJobspressoItems } from "../sources/jobspresso.mjs";
import { meta as indeedMeta, fetchJobs as fetchIndeed } from "../sources/indeed.mjs";

test("greenhouse maps board JSON to the shared job shape", () => {
  const jobs = normalizeGreenhouseJobs(
    {
      jobs: [
        {
          title: "Senior Product Manager, Growth",
          company_name: "GitLab",
          absolute_url: "https://job-boards.greenhouse.io/gitlab/jobs/8684348002",
          location: { name: "Remote, United States" },
          first_published: "2026-04-17T05:58:03-04:00"
        }
      ]
    },
    { companyName: "GitLab" }
  );
  assert.deepEqual(jobs[0], {
    company: "GitLab",
    title: "Senior Product Manager, Growth",
    url: "https://job-boards.greenhouse.io/gitlab/jobs/8684348002",
    source: "greenhouse",
    work_type: "Remote, United States",
    posted: "2026-04-17T09:58:03.000Z"
  });
});

test("lever maps postings JSON to the shared job shape", () => {
  const jobs = normalizeLeverJobs(
    [
      {
        text: "AI Product Manager",
        hostedUrl: "https://jobs.lever.co/airslate/5e6dec30-136f-4d26-91f4-ff2ac33ea167",
        workplaceType: "remote",
        createdAt: 1783954170591,
        categories: { location: "United States", commitment: "Full-time" }
      }
    ],
    { companyName: "airSlate" }
  );
  assert.equal(jobs[0].company, "airSlate");
  assert.equal(jobs[0].title, "AI Product Manager");
  assert.equal(jobs[0].source, "lever");
  assert.match(jobs[0].work_type, /remote/i);
  assert.match(jobs[0].work_type, /United States/);
});

test("ashby maps job-board JSON to the shared job shape", () => {
  const jobs = normalizeAshbyJobs(
    {
      jobs: [
        {
          title: "Senior Product Manager - Special Projects",
          jobUrl: "https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8",
          workplaceType: "Remote",
          employmentType: "FullTime",
          location: "United States",
          isRemote: true,
          publishedAt: "2025-05-04T15:46:52.228+00:00"
        }
      ]
    },
    { companyName: "Tremendous" }
  );
  assert.equal(jobs[0].company, "Tremendous");
  assert.equal(jobs[0].source, "ashby");
  assert.equal(jobs[0].url, "https://jobs.ashbyhq.com/tremendous/9be1cf09-1eb7-4aa7-8bc4-4848cc124fb8");
});

test("remoteok skips the legal notice element", () => {
  const jobs = normalizeRemoteOkJobs([
    { legal: "API Terms of Service" },
    {
      company: "Acme",
      position: "Product Manager",
      url: "https://remoteok.com/remote-jobs/1",
      location: "Worldwide",
      date: "2026-08-22T00:00:12+00:00"
    }
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source, "remoteok");
  assert.equal(jobs[0].title, "Product Manager");
});

test("himalayas maps browse JSON to the shared job shape", () => {
  const jobs = normalizeHimalayasJobs({
    jobs: [
      {
        title: "Senior Product Manager",
        companyName: "Linear",
        applicationLink: "https://himalayas.app/companies/linear/jobs/spm",
        employmentType: "Full Time",
        locationRestrictions: [{ name: "United States" }],
        pubDate: 1787437401
      }
    ]
  });
  assert.equal(jobs[0].company, "Linear");
  assert.equal(jobs[0].source, "himalayas");
  assert.match(jobs[0].work_type, /Full Time/);
});

test("weworkremotely splits Company: Title and reads type/region", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Pendo: Director, Customer Growth</title>
      <link>https://weworkremotely.com/remote-jobs/pendo-director</link>
      <pubDate>Fri, 21 Aug 2026 12:00:00 +0000</pubDate>
      <region>Anywhere in the World</region>
      <type>Full-Time</type>
    </item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  const jobs = normalizeWeWorkRemotelyItems(items);
  assert.equal(jobs[0].company, "Pendo");
  assert.equal(jobs[0].title, "Director, Customer Growth");
  assert.equal(jobs[0].source, "weworkremotely");
  assert.match(jobs[0].work_type, /Full-Time/);
});

test("jobspresso reads company from dc:creator", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Senior Product Designer</title>
      <link>https://jobspresso.co/job/senior-product-designer-22/</link>
      <dc:creator><![CDATA[The Athletic<br>United States]]></dc:creator>
      <pubDate>Mon, 10 Aug 2026 02:15:09 +0000</pubDate>
    </item>
  </channel></rss>`;
  const jobs = normalizeJobspressoItems(parseRssItems(xml));
  assert.equal(jobs[0].company, "The Athletic");
  assert.equal(jobs[0].source, "jobspresso");
});

test("query words use word boundaries so Productivity is not product", async () => {
  const { filterJobs } = await import("../jobs.mjs");
  const rows = filterJobs(
    [
      {
        company: "GitLab",
        title: "Manager, Engineering, Nonlinear Productivity",
        url: "https://example.com/1",
        source: "greenhouse",
        work_type: "Remote",
        posted: null
      },
      {
        company: "GitLab",
        title: "Senior Product Manager, Growth",
        url: "https://example.com/2",
        source: "greenhouse",
        work_type: "Remote US",
        posted: null
      }
    ],
    { query: "product manager" }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Senior Product Manager, Growth");
});

test("indeed meta is present and fetchJobs throws the documented error", async () => {
  assert.equal(indeedMeta.id, "indeed");
  await assert.rejects(
    () => fetchIndeed({ limit: 10, query: "product manager" }),
    /no working Indeed source — see SOURCES-VERIFIED.md/
  );
});
