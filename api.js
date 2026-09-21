/*
 * api.js — talks to Canvas's own REST API on the current origin only.
 * No external servers, no third-party requests. Follows Link header
 * pagination. Callers get either data or a normalized error with a
 * `.status` (401 / 403 / 0 for network failure).
 */
(function (global) {
  'use strict';

  function parseNextLink(linkHeader) {
    if (!linkHeader) return null;
    var parts = linkHeader.split(',');
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(/<([^>]+)>;\s*rel="([^"]+)"/);
      if (m && m[2] === 'next') return m[1];
    }
    return null;
  }

  async function fetchAllPages(url) {
    var results = [];
    var next = url;
    var guard = 0;
    while (next && guard < 50) {
      guard++;
      var res;
      try {
        res = await fetch(next, {
          credentials: 'include',
          headers: { Accept: 'application/json' }
        });
      } catch (e) {
        var netErr = new Error('network failure');
        netErr.status = 0;
        throw netErr;
      }
      if (!res.ok) {
        var err = new Error('Canvas API error ' + res.status);
        err.status = res.status;
        throw err;
      }
      var data = await res.json();
      if (Array.isArray(data)) {
        results = results.concat(data);
      } else {
        results.push(data);
      }
      next = parseNextLink(res.headers.get('Link'));
    }
    return results;
  }

  function isoDate(d) {
    return d.toISOString();
  }

  var CdxApi = {
    // Wide-ish window so Day/Week/Month ring views and recently-overdue
    // "missing" items are all covered by one fetch.
    async getPlannerItems(now) {
      now = now || new Date();
      var start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      var end = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
      var params = new URLSearchParams();
      params.set('per_page', '50');
      params.set('start_date', isoDate(start));
      params.set('end_date', isoDate(end));
      var url = '/api/v1/planner/items?' + params.toString();
      var raw = await fetchAllPages(url);
      return raw;
    },

    // Canvas's own "missing" endpoint, used to catch overdue assignments
    // that fall outside the planner window above.
    async getMissingSubmissions() {
      var params = new URLSearchParams();
      params.set('per_page', '50');
      params.append('include[]', 'course');
      var url = '/api/v1/users/self/missing_submissions?' + params.toString();
      return fetchAllPages(url);
    },

    async getEnrollmentsWithGrades() {
      var params = new URLSearchParams();
      params.set('per_page', '100');
      params.append('type[]', 'StudentEnrollment');
      params.append('state[]', 'active');
      params.append('include[]', 'grades');
      var url = '/api/v1/users/self/enrollments?' + params.toString();
      return fetchAllPages(url);
    }
  };

  global.CdxApi = CdxApi;
})(window);
