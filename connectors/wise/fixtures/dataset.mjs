/**
 * A synthetic Wise account, the source the recording emulator serves. No
 * real data: every id, name and amount is generated, every address is
 * @example.com. Deterministic, so a re-record changes nothing.
 *
 * Shapes follow Wise's API. Two profiles, so every per-profile walk crosses
 * a profile boundary, and enough rows for every page boundary:
 *
 * - transfers: 203 on the personal profile (pages of 100, 100, 3) and 4 on
 *   the business one, `created` without a time zone, as Wise sends it;
 * - recipients: 45 and 3. Wise caps `size` at 20, so pages are shorter than
 *   asked. The personal profile's last page echoes the seek position it was
 *   sent; the business one ends on an empty page;
 * - activities: 120 and 60 at 50 a page. The business profile's last page
 *   echoes the cursor it was sent, which ends the walk;
 * - balances: 2 and 3, one created after "now", so its statement is
 *   skipped. The business profile's statements need strong customer
 *   authentication (SCA);
 * - statements: transactions spread over each balance's life, read in
 *   90-day windows.
 */

export const FIXTURE_NOW = "2026-11-16T12:00:00.000Z";

export const PERSONAL = 11111111;
export const BUSINESS = 22222222;

const pad = (n, width = 2) => String(n).padStart(width, "0");

/** `YYYY-MM-DD HH:mm:ss`, UTC, as Wise writes a transfer's `created`. */
const wiseTime = ms => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};
const iso = ms => new Date(ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse(FIXTURE_NOW);

function profiles() {
  return [
    {
      id: PERSONAL,
      publicId: "pub-personal-0001",
      userId: 9000001,
      type: "PERSONAL",
      email: "person@example.com",
      createdAt: "2024-02-01T10:00:00",
      updatedAt: "2026-05-01T09:30:00",
      version: 3,
      obfuscated: false,
      currentState: "VISIBLE",
      firstName: "Alex",
      lastName: "Example",
      fullName: "Alex Example",
      dateOfBirth: "1990-01-01",
      phoneNumber: "+10000000000",
      address: {
        addressFirstLine: "1 Example Street",
        city: "Exampleton",
        countryIso3Code: "gbr",
        postCode: "EX1 1AA",
      },
      contactDetails: { email: "person@example.com" },
    },
    {
      id: BUSINESS,
      publicId: "pub-business-0002",
      userId: 9000001,
      type: "BUSINESS",
      email: "finance@example.com",
      createdAt: "2024-03-15T08:00:00",
      updatedAt: "2026-09-12T14:00:00",
      version: 7,
      obfuscated: false,
      currentState: "VISIBLE",
      businessName: "Example Ltd",
      registrationNumber: "00000000",
      companyType: "LIMITED",
      companyRole: "OWNER",
      firstLevelCategory: "CONSULTING_IT_BUSINESS_SERVICES",
      secondLevelCategory: "SOFTWARE",
      descriptionOfBusiness: "Software",
      webpage: "https://www.example.com",
      fullName: "Example Ltd",
      address: {
        addressFirstLine: "2 Example Road",
        city: "Exampleton",
        countryIso3Code: "che",
        postCode: "1000",
      },
      contactDetails: { email: "finance@example.com" },
      operationalAddresses: [],
    },
  ];
}

const money = (value, currency) => ({ value, currency });

function balances() {
  const balance = (id, profileId, currency, created, modified, amount) => ({
    id,
    currency,
    type: "STANDARD",
    name: null,
    icon: null,
    investmentState: "NOT_INVESTED",
    amount: money(amount, currency),
    reservedAmount: money(0, currency),
    cashAmount: money(amount, currency),
    totalWorth: money(amount, currency),
    creationTime: created,
    modificationTime: modified,
    visible: true,
    primary: currency === "EUR",
    groupId: null,
    __profileId: profileId,
  });
  return [
    balance(
      301,
      PERSONAL,
      "EUR",
      "2026-03-01T09:00:00.000Z",
      "2026-11-10T08:00:00.000Z",
      1234.56,
    ),
    balance(
      302,
      PERSONAL,
      "GBP",
      "2026-08-20T09:00:00.000Z",
      "2026-11-12T08:00:00.000Z",
      88.93,
    ),
    balance(
      401,
      BUSINESS,
      "EUR",
      "2026-05-10T09:00:00.000Z",
      "2026-11-14T08:00:00.000Z",
      45210.5,
    ),
    balance(
      402,
      BUSINESS,
      "USD",
      "2026-10-30T09:00:00.000Z",
      "2026-11-15T08:00:00.000Z",
      310.74,
    ),
    // Created after "now": no statement window, skipped without a request.
    balance(
      403,
      BUSINESS,
      "CHF",
      "2026-11-20T09:00:00.000Z",
      "2026-11-20T09:00:00.000Z",
      0,
    ),
  ];
}

const STATES = [
  "outgoing_payment_sent",
  "funds_converted",
  "processing",
  "cancelled",
  "incoming_payment_waiting",
];

function transfers() {
  const out = [];
  const make = (i, profileId, createdMs) => ({
    id: (profileId === BUSINESS ? 52_000_000 : 51_000_000) + i,
    user: 9000001,
    targetAccount: 70_000_000 + (i % 45),
    sourceAccount: null,
    quote: null,
    quoteUuid: `00000000-0000-4000-8000-${pad(i, 12)}`,
    status: STATES[i % STATES.length],
    reference: `Invoice ${i}`,
    rate: 1 + (i % 7) / 100,
    created: wiseTime(createdMs),
    business: profileId === BUSINESS ? BUSINESS : null,
    details: { reference: `Invoice ${i}` },
    hasActiveIssues: i % 50 === 0,
    sourceCurrency: "EUR",
    sourceValue: 100 + i,
    targetCurrency: i % 2 ? "GBP" : "CHF",
    targetValue: Math.round((100 + i) * (1 + (i % 7) / 100) * 100) / 100,
    customerTransactionId: `00000000-0000-4000-9000-${pad(i, 12)}`,
    __profileId: profileId,
  });
  // 203 personal transfers, one every 2.5 days back from now.
  for (let i = 0; i < 203; i++) {
    out.push(make(i, PERSONAL, NOW - DAY - i * 60 * HOUR));
  }
  for (let i = 0; i < 4; i++) {
    out.push(make(i, BUSINESS, NOW - 3 * DAY - i * 40 * DAY));
  }
  return out;
}

function recipients() {
  const out = [];
  const make = (i, profileId) => ({
    id: 70_000_000 + (profileId === BUSINESS ? 1000 : 0) + i,
    creatorId: 9000001,
    profileId,
    currency: i % 2 ? "GBP" : "EUR",
    country: i % 2 ? "GB" : "DE",
    type: i % 2 ? "SortCode" : "Iban",
    legalEntityType: i % 3 ? "PERSON" : "BUSINESS",
    active: i % 9 !== 0,
    name: { fullName: `Recipient ${i}`, givenName: null, familyName: null },
    email: i % 4 === 0 ? `recipient${i}@example.com` : null,
    details: { reference: null },
    commonFieldMap: { accountNumberField: "IBAN" },
    hash: `hash-${pad(i, 4)}`,
    accountSummary: `Recipient ${i} ending ${pad(i, 4)}`,
    longAccountSummary: `Recipient ${i}, account ending ${pad(i, 4)}`,
    displayFields: [{ key: "IBAN", label: "IBAN", value: `XX00${pad(i, 4)}` }],
    isInternal: false,
    ownedByCustomer: i % 5 === 0,
    nickname: null,
    isDefaultAccount: false,
    __profileId: profileId,
  });
  for (let i = 0; i < 45; i++) out.push(make(i, PERSONAL));
  for (let i = 0; i < 3; i++) out.push(make(i, BUSINESS));
  return out;
}

function activities() {
  const out = [];
  const make = (i, profileId, createdMs) => ({
    id: `ACT-${profileId === BUSINESS ? "B" : "P"}-${pad(i, 5)}`,
    type: i % 3 ? "CARD_PAYMENT" : "TRANSFER",
    resource: {
      type: i % 3 ? "CARD_TRANSACTION" : "TRANSFER",
      id: `${1000 + i}`,
    },
    title: `<strong>Merchant ${i}</strong>`,
    description: i % 4 ? "Spent" : "Sent",
    primaryAmount:
      i % 5 ? `${10 + i}.50 EUR` : `<positive>+ ${10 + i}.00 EUR</positive>`,
    secondaryAmount: i % 7 ? "" : `${9 + i}.12 GBP`,
    status: i % 11 ? "COMPLETED" : "CANCELLED",
    createdOn: iso(createdMs),
    updatedOn: iso(createdMs + (i % 3) * HOUR),
    __profileId: profileId,
  });
  for (let i = 0; i < 120; i++)
    out.push(make(i, PERSONAL, NOW - 2 * HOUR - i * 52 * HOUR));
  for (let i = 0; i < 60; i++)
    out.push(make(i, BUSINESS, NOW - 5 * HOUR - i * 70 * HOUR));
  return out;
}

/** Transactions per balance, every 9 days from creation to now. */
function statements(allBalances) {
  const byBalance = new Map();
  for (const balance of allBalances) {
    const rows = [];
    const start = Date.parse(balance.creationTime);
    let running = 0;
    for (let t = start + 2 * DAY, i = 0; t < NOW; t += 9 * DAY, i++) {
      const credit = i % 3 === 0;
      const value = credit ? 500 + i : -(20 + i);
      running = Math.round((running + value) * 100) / 100;
      rows.push({
        type: credit ? "CREDIT" : "DEBIT",
        date: iso(t),
        amount: money(value, balance.currency),
        totalFees: money(credit ? 0 : 0.35, balance.currency),
        details: credit
          ? { type: "DEPOSIT", description: `Received money ${i}` }
          : { type: "CARD", description: `Card transaction ${i}` },
        exchangeDetails: null,
        runningBalance: money(running, balance.currency),
        referenceNumber: `${credit ? "TRANSFER" : "CARD"}-${balance.id}${pad(i, 4)}`,
      });
    }
    // A card payment and its refund on the same reference and day.
    if (rows.length > 3) {
      const paid = rows[1];
      rows.splice(2, 0, {
        ...paid,
        type: "CREDIT",
        amount: money(-paid.amount.value, balance.currency),
        details: { type: "CARD", description: "Card refund" },
      });
    }
    byBalance.set(balance.id, rows);
  }
  return byBalance;
}

export function buildDataset() {
  const allBalances = balances();
  return {
    now: FIXTURE_NOW,
    me: { id: 9000001, email: "owner@example.com", active: true },
    profiles: profiles(),
    balances: allBalances,
    transfers: transfers(),
    recipients: recipients(),
    activities: activities(),
    statements: statements(allBalances),
    /** Profiles whose statements answer 403 with an SCA challenge first. */
    scaProfiles: new Set([String(BUSINESS)]),
    /** How a profile's recipient walk ends. */
    recipientEnd: { [PERSONAL]: "echo", [BUSINESS]: "empty" },
    /** How a profile's activity walk ends. */
    activityEnd: { [PERSONAL]: "null", [BUSINESS]: "echo" },
    /** Paths answered 400, for the webhook fill's failure path. */
    failing: new Set(["/v1/transfers/59000400"]),
  };
}
