/**
 * Sample systems — an in-memory CRM, marketing platform, support desk,
 * billing system and product-analytics store, seeded per workspace.
 *
 * They exist so the reference processes run end to end without third-party
 * credentials (local dev, demos, tests). They are deliberately shaped like the
 * real thing — search vs delete, suppression vs deletion, legal retention —
 * so the agent has something real to reason about. Swap a sample tool for a
 * real one (same name prefix, same effect) to go live; process code does not
 * change.
 *
 * State is per API process and is lost on restart. Never use for real data.
 */
import { defineTool, z } from "../sdk";

interface Contact {
  id: string;
  email: string;
  name: string;
  company: string;
  phone?: string;
  notes?: string;
  accountId?: string;
}
interface Account {
  id: string;
  name: string;
  csmEmail: string;
  arr: number;
  seats: number;
  plan: string;
}
interface Ticket {
  id: string;
  requesterEmail: string;
  subject: string;
  body: string;
  redacted: boolean;
}
interface Lead {
  id: string;
  email: string;
  name: string;
  company?: string;
  title?: string;
  source: string;
  status: "new" | "qualified" | "disqualified";
  score?: number;
  enrichment?: Record<string, unknown>;
}

interface WorkspaceSample {
  contacts: Map<string, Contact>;
  accounts: Map<string, Account>;
  marketing: Map<
    string,
    { email: string; lists: string[]; suppressed: boolean }
  >;
  tickets: Map<string, Ticket>;
  billing: Map<
    string,
    {
      customerId: string;
      email: string;
      invoices: number;
      lastInvoiceAt: string;
    }
  >;
  usage: Map<string, number[]>; // accountId → weekly active users, oldest → newest
  leads: Map<string, Lead>;
}

const workspaces = new Map<string, WorkspaceSample>();

function seed(): WorkspaceSample {
  const accounts: Account[] = [
    {
      id: "acc_1",
      name: "Northwind Traders",
      csmEmail: "csm.anna@example.com",
      arr: 48_000,
      seats: 60,
      plan: "business",
    },
    {
      id: "acc_2",
      name: "Globex",
      csmEmail: "csm.bruno@example.com",
      arr: 12_000,
      seats: 15,
      plan: "team",
    },
    {
      id: "acc_3",
      name: "Initech",
      csmEmail: "csm.anna@example.com",
      arr: 96_000,
      seats: 140,
      plan: "enterprise",
    },
    {
      id: "acc_4",
      name: "Umbrella Corp",
      csmEmail: "csm.bruno@example.com",
      arr: 7_200,
      seats: 8,
      plan: "team",
    },
  ];
  const contacts: Contact[] = [
    {
      id: "ct_101",
      email: "jane.doe@example.org",
      name: "Jane Doe",
      company: "Northwind Traders",
      phone: "+41 79 555 01 01",
      notes: "Asked about invoicing in March.",
      accountId: "acc_1",
    },
    {
      id: "ct_102",
      email: "j.doe@northwind.example",
      name: "Jane Doe",
      company: "Northwind Traders",
      accountId: "acc_1",
    },
    {
      id: "ct_103",
      email: "peter.gibbons@initech.example",
      name: "Peter Gibbons",
      company: "Initech",
      accountId: "acc_3",
    },
    {
      id: "ct_104",
      email: "hank@globex.example",
      name: "Hank Scorpio",
      company: "Globex",
      accountId: "acc_2",
    },
  ];
  return {
    contacts: new Map(contacts.map(c => [c.id, c])),
    accounts: new Map(accounts.map(a => [a.id, a])),
    marketing: new Map([
      [
        "jane.doe@example.org",
        {
          email: "jane.doe@example.org",
          lists: ["newsletter", "product-updates"],
          suppressed: false,
        },
      ],
      [
        "peter.gibbons@initech.example",
        {
          email: "peter.gibbons@initech.example",
          lists: ["newsletter"],
          suppressed: false,
        },
      ],
    ]),
    tickets: new Map([
      [
        "tk_9001",
        {
          id: "tk_9001",
          requesterEmail: "jane.doe@example.org",
          subject: "Cannot export CSV",
          body: "Hi, I'm Jane Doe (+41 79 555 01 01). Export fails.",
          redacted: false,
        },
      ],
      [
        "tk_9002",
        {
          id: "tk_9002",
          requesterEmail: "jane.doe@example.org",
          subject: "Delete my data",
          body: "Please delete all my personal data.",
          redacted: false,
        },
      ],
      [
        "tk_9003",
        {
          id: "tk_9003",
          requesterEmail: "hank@globex.example",
          subject: "SSO setup",
          body: "How do we configure SAML?",
          redacted: false,
        },
      ],
    ]),
    billing: new Map([
      [
        "jane.doe@example.org",
        {
          customerId: "cus_77",
          email: "jane.doe@example.org",
          invoices: 14,
          lastInvoiceAt: "2026-09-01",
        },
      ],
    ]),
    usage: new Map([
      ["acc_1", [52, 50, 47, 41, 30, 22]],
      ["acc_2", [11, 12, 12, 13, 12, 13]],
      ["acc_3", [120, 118, 121, 119, 122, 125]],
      ["acc_4", [6, 5, 3, 2, 1, 0]],
    ]),
    leads: new Map(
      [
        {
          id: "ld_1",
          email: "maria.lopez@acme-logistics.example",
          name: "Maria Lopez",
          company: "Acme Logistics",
          title: "Head of Data",
          source: "webinar",
          status: "new" as const,
        },
        {
          id: "ld_2",
          email: "tom@gmail.example",
          name: "Tom",
          source: "newsletter",
          status: "new" as const,
        },
        {
          id: "ld_3",
          email: "k.ito@shinkansen-bank.example",
          name: "Kenji Ito",
          company: "Shinkansen Bank",
          title: "CTO",
          source: "demo-request",
          status: "new" as const,
        },
      ].map(l => [l.id, l]),
    ),
  };
}

export function sampleSystems(workspaceId: string): WorkspaceSample {
  let state = workspaces.get(workspaceId);
  if (!state) {
    state = seed();
    workspaces.set(workspaceId, state);
  }
  return state;
}

/** Tests: start from the seed again. */
export function resetSampleSystems(): void {
  workspaces.clear();
}

const norm = (s: string) => s.trim().toLowerCase();

// ── CRM ────────────────────────────────────────────────────────────────────

export const crmContactSearch = defineTool({
  name: "crm.contact.search",
  description:
    "Search CRM contacts by email (exact, case-insensitive) or name (substring). Returns full records.",
  effect: "read",
  input: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
  }),
  async execute({ email, name }, t) {
    const all = [...sampleSystems(t.workspaceId).contacts.values()];
    return {
      contacts: all.filter(
        c =>
          (email && norm(c.email) === norm(email)) ||
          (name && norm(c.name).includes(norm(name))),
      ),
    };
  },
});

export const crmContactDelete = defineTool({
  name: "crm.contact.delete",
  description: "Permanently delete a CRM contact by id.",
  effect: "destructive",
  input: z.object({ contactId: z.string() }),
  output: z.object({ contactId: z.string(), deleted: z.boolean() }),
  async execute({ contactId }, t) {
    const existed = sampleSystems(t.workspaceId).contacts.delete(contactId);
    t.log(existed ? "Contact deleted" : "Contact already absent", {
      contactId,
    });
    return { contactId, deleted: existed };
  },
  async reconcile({ contactId }, t) {
    return sampleSystems(t.workspaceId).contacts.has(contactId)
      ? { done: false }
      : { done: true, output: { contactId, deleted: true } };
  },
});

export const crmAccountList = defineTool({
  name: "crm.account.list",
  description:
    "List customer accounts with ARR, seats, plan and the assigned CSM.",
  effect: "read",
  input: z.object({}),
  async execute(_input, t) {
    return { accounts: [...sampleSystems(t.workspaceId).accounts.values()] };
  },
});

export const crmLeadList = defineTool({
  name: "crm.lead.list",
  description: "List CRM leads with a given status.",
  effect: "read",
  input: z.object({
    status: z.enum(["new", "qualified", "disqualified"]).default("new"),
  }),
  async execute({ status }, t) {
    return {
      leads: [...sampleSystems(t.workspaceId).leads.values()].filter(
        l => l.status === status,
      ),
    };
  },
});

export const crmLeadUpdate = defineTool({
  name: "crm.lead.update",
  description: "Update a lead's status, score and enrichment fields.",
  effect: "write",
  input: z.object({
    leadId: z.string(),
    status: z.enum(["new", "qualified", "disqualified"]),
    score: z.number().min(0).max(100).optional(),
    enrichment: z.record(z.string(), z.unknown()).optional(),
  }),
  async execute({ leadId, ...patch }, t) {
    const lead = sampleSystems(t.workspaceId).leads.get(leadId);
    if (!lead) throw new Error(`Lead ${leadId} not found`);
    Object.assign(lead, patch);
    return { lead };
  },
});

// ── Marketing ──────────────────────────────────────────────────────────────

export const marketingContactLookup = defineTool({
  name: "marketing.contact.lookup",
  description:
    "Look up an email address in the marketing platform (lists, suppression state).",
  effect: "read",
  input: z.object({ email: z.string() }),
  async execute({ email }, t) {
    return {
      contact: sampleSystems(t.workspaceId).marketing.get(norm(email)) ?? null,
    };
  },
});

export const marketingContactSuppress = defineTool({
  name: "marketing.contact.suppress",
  description:
    "Remove an address from all lists and add it to the global suppression list (idempotent).",
  effect: "write",
  input: z.object({ email: z.string() }),
  async execute({ email }, t) {
    const state = sampleSystems(t.workspaceId).marketing;
    state.set(norm(email), { email: norm(email), lists: [], suppressed: true });
    return { email: norm(email), suppressed: true };
  },
});

// ── Support ────────────────────────────────────────────────────────────────

export const supportTicketSearch = defineTool({
  name: "support.ticket.search",
  description: "Find support tickets by requester email.",
  effect: "read",
  input: z.object({ requesterEmail: z.string() }),
  async execute({ requesterEmail }, t) {
    return {
      tickets: [...sampleSystems(t.workspaceId).tickets.values()].filter(
        tk => norm(tk.requesterEmail) === norm(requesterEmail),
      ),
    };
  },
});

export const supportTicketRedact = defineTool({
  name: "support.ticket.redact",
  description:
    "Irreversibly redact personal data from a ticket (requester and body replaced).",
  effect: "destructive",
  input: z.object({ ticketId: z.string() }),
  async execute({ ticketId }, t) {
    const ticket = sampleSystems(t.workspaceId).tickets.get(ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    Object.assign(ticket, {
      requesterEmail: "redacted@invalid",
      body: "[redacted on data-subject request]",
      redacted: true,
    });
    return { ticketId, redacted: true };
  },
  async reconcile({ ticketId }, t) {
    const ticket = sampleSystems(t.workspaceId).tickets.get(ticketId);
    return ticket?.redacted
      ? { done: true, output: { ticketId, redacted: true } }
      : { done: false };
  },
});

// ── Billing (legal retention: read-only by design) ─────────────────────────

export const billingCustomerLookup = defineTool({
  name: "billing.customer.lookup",
  description:
    "Look up a billing customer by email. Billing records are subject to statutory " +
    "retention (10 years) and cannot be deleted; they may only be restricted.",
  effect: "read",
  input: z.object({ email: z.string() }),
  async execute({ email }, t) {
    return {
      customer: sampleSystems(t.workspaceId).billing.get(norm(email)) ?? null,
      retention: "10y statutory (accounting law)",
    };
  },
});

// ── Product analytics ──────────────────────────────────────────────────────

export const productUsageWeekly = defineTool({
  name: "product.usage.weekly",
  description:
    "Weekly active users for an account over the last 6 weeks (oldest first).",
  effect: "read",
  input: z.object({ accountId: z.string() }),
  async execute({ accountId }, t) {
    return {
      accountId,
      weeklyActiveUsers:
        sampleSystems(t.workspaceId).usage.get(accountId) ?? [],
    };
  },
});

/** The whole sample toolkit, grouped for envelopes. */
export const sample = {
  crmContactSearch,
  crmContactDelete,
  crmAccountList,
  crmLeadList,
  crmLeadUpdate,
  marketingContactLookup,
  marketingContactSuppress,
  supportTicketSearch,
  supportTicketRedact,
  billingCustomerLookup,
  productUsageWeekly,
};
