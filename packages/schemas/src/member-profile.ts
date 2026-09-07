/**
 * A workspace member's PROFILE — what they do and where — as opposed to their
 * access role (owner/admin/member/viewer, which decides what they may touch
 * in Mako). Set on the Members page; read by published apps as the viewer's
 * `role` and `country` claims (apps.md §27), so an app can scope its data
 * per person without any list of people in its repo.
 */
export const JOB_ROLES = [
  "sdr",
  "bdr",
  "csm",
  "head_of_csm",
  "team_leader",
  "developer",
  "admin",
] as const;
export type JobRole = (typeof JOB_ROLES)[number];

export const JOB_ROLE_LABELS: Record<JobRole, string> = {
  sdr: "SDR",
  bdr: "BDR",
  csm: "CSM",
  head_of_csm: "Head of CSM",
  team_leader: "Team leader",
  developer: "Developer",
  admin: "Admin",
};

export function isJobRole(value: unknown): value is JobRole {
  return typeof value === "string" && (JOB_ROLES as readonly string[]).includes(value);
}

/** ISO 3166-1 alpha-2. */
export const COUNTRY_CODES = [
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR","AS","AT","AU","AW","AX","AZ",
  "BA","BB","BD","BE","BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ","BR","BS","BT","BV","BW","BY","BZ",
  "CA","CC","CD","CF","CG","CH","CI","CK","CL","CM","CN","CO","CR","CU","CV","CW","CX","CY","CZ",
  "DE","DJ","DK","DM","DO","DZ","EC","EE","EG","EH","ER","ES","ET",
  "FI","FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF","GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS","GT","GU","GW","GY",
  "HK","HM","HN","HR","HT","HU","ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT","JE","JM","JO","JP",
  "KE","KG","KH","KI","KM","KN","KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK","LR","LS","LT","LU","LV","LY",
  "MA","MC","MD","ME","MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ","MR","MS","MT","MU","MV","MW","MX","MY","MZ",
  "NA","NC","NE","NF","NG","NI","NL","NO","NP","NR","NU","NZ","OM",
  "PA","PE","PF","PG","PH","PK","PL","PM","PN","PR","PS","PT","PW","PY","QA","RE","RO","RS","RU","RW",
  "SA","SB","SC","SD","SE","SG","SH","SI","SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV","SX","SY","SZ",
  "TC","TD","TF","TG","TH","TJ","TK","TL","TM","TN","TO","TR","TT","TV","TW","TZ",
  "UA","UG","UM","US","UY","UZ","VA","VC","VE","VG","VI","VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === "string" && (COUNTRY_CODES as readonly string[]).includes(value);
}
