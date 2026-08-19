// Thin client for the GoHighLevel (LeadConnector) v2 API.
//
// IMPORTANT: I built this against my best knowledge of the GHL v2 API
// contract, but I could not render GHL's live API reference from this
// environment to verify every exact param name (it's a JS-rendered
// Stoplight page, opaque to a plain fetch). GHL's v2 API is also known to
// mix camelCase and snake_case across a few endpoints (a real quirk of
// their API, not a typo here).
//
// If a call below 400s on first run, the error logged to the Action's
// output will include GHL's own message -- paste that back and it's
// almost always a one-line param-name fix in this file.

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

export class GhlError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export function createClient({ token, locationId }) {
  if (!token) throw new Error("GHL_PIT is required (Private Integration Token).");
  if (!locationId) throw new Error("GHL_LOCATION_ID is required.");

  async function request(path, { query = {}, method = "GET" } = {}) {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: API_VERSION,
        Accept: "application/json",
      },
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (!res.ok) {
      throw new GhlError(
        `GHL API ${res.status} on ${path}: ${body?.message || res.statusText}`,
        { status: res.status, url: url.toString(), body }
      );
    }
    return body;
  }

  async function paginate(path, { query = {}, listKey, pageSize = 100, maxPages = 50 } = {}) {
    const items = [];
    let page = 1;
    for (; page <= maxPages; page++) {
      const body = await request(path, {
        query: { ...query, locationId, limit: pageSize, page },
      });
      const batch = listKey ? body?.[listKey] : body;
      if (!Array.isArray(batch) || batch.length === 0) break;
      items.push(...batch);
      if (batch.length < pageSize) break;
    }
    return items;
  }

  return {
    locationId,
    request,
    paginate,

    listUsers: () => request("/users/", { query: { locationId } }).then((b) => b.users ?? []),

    listCustomFields: () =>
      request(`/locations/${locationId}/customFields`).then((b) => b.customFields ?? []),

    listPipelines: () => request("/opportunities/pipelines", { query: { locationId } }).then((b) => b.pipelines ?? []),

    listCalendars: () => request("/calendars/", { query: { locationId } }).then((b) => b.calendars ?? []),

    listCalendarEvents: ({ calendarId, startTime, endTime }) =>
      request("/calendars/events", {
        query: { locationId, calendarId, startTime, endTime },
      }).then((b) => b.events ?? []),

    searchOpportunities: ({ pipelineId, page = 1, limit = 100 }) =>
      // NOTE: GHL's opportunity search historically uses snake_case params
      // even though most v2 endpoints are camelCase. Flagged in the header
      // comment above -- fix here if the live response disagrees.
      request("/opportunities/search", {
        query: { location_id: locationId, pipeline_id: pipelineId, page, limit },
      }).then((b) => b.opportunities ?? []),

    searchConversations: ({ startAfterDate, limit = 100 } = {}) =>
      request("/conversations/search", {
        query: { locationId, limit, startAfterDate },
      }).then((b) => b.conversations ?? []),

    // SALES | QUALIFICATION and SALES | HANDOFF (checklist items 2-3) are
    // built as Contact custom fields, not Opportunity custom fields -- so
    // qualification/handoff data has to be read off the contact, keyed by
    // each opportunity's contactId.
    getContact: (contactId) =>
      request(`/contacts/${contactId}`).then((b) => b.contact ?? null),

    // Cash Collected comes from actual GHL Payments transactions, not a
    // custom field. NOTE: GHL's Payments API is documented (elsewhere) to
    // use altId/altType instead of locationId on some endpoints -- that
    // convention is applied here on best knowledge, not confirmed against
    // a live response yet. If this 400s, the fix is almost certainly the
    // query param names below, not the overall approach.
    listTransactions: async ({ startAt, endAt }) => {
      const items = [];
      let offset = 0;
      const limit = 100;
      for (;;) {
        const body = await request("/payments/transactions", {
          query: { altId: locationId, altType: "location", startAt, endAt, limit, offset },
        });
        const batch = body.data ?? body.transactions ?? [];
        items.push(...batch);
        if (batch.length < limit) break;
        offset += limit;
        if (offset > 5000) break; // safety backstop
      }
      return items;
    },
  };
}
