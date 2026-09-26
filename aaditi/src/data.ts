// Mock tenants, agents, users and scripted conversations.
// Every tenant is isolated: its agents only see its own users, and every source ref
// resolves inside that tenant's namespace (shown as src[tenant] in the UI).

export type Outcome = 'verified' | 'mismatch' | 'unverified'
export type SourceSpec = { ref: string; outcome: Outcome; note?: string }
export type Exchange = { u: string; us: SourceSpec[]; a: string; as: SourceSpec[] }

export type Tenant = { id: string; name: string; region: string; plan: string; color: string }
export type Agent = { id: string; tenantId: string; name: string; role: string; model: string }
export type User = { id: string; tenantId: string; name: string; email: string; vars: Record<string, string> }
export type ChatDef = { id: string; tenantId: string; agentId: string; userId: string }

export const ok = (ref: string, note?: string): SourceSpec => ({ ref, note, outcome: 'verified' })
const bad = (ref: string, note: string): SourceSpec => ({ ref, note, outcome: 'mismatch' })
const unk = (ref: string, note: string): SourceSpec => ({ ref, note, outcome: 'unverified' })

export const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

export const TENANTS: Tenant[] = [
  { id: 'acme', name: 'Acme Logistics', region: 'us-east-1', plan: 'enterprise', color: '#f5a524' },
  { id: 'globex', name: 'Globex Bank', region: 'eu-west-1', plan: 'regulated', color: '#22d3ee' },
  { id: 'initech', name: 'Initech Cloud', region: 'us-west-2', plan: 'growth', color: '#a78bfa' },
]

export const AGENTS: Agent[] = [
  { id: 'acme.dispatch', tenantId: 'acme', name: 'dispatch', role: 'Shipment tracking and reroutes', model: 'claude-sonnet-5' },
  { id: 'acme.support', tenantId: 'acme', name: 'support', role: 'Tier-1 customer support', model: 'claude-haiku-4-5' },
  { id: 'acme.claims', tenantId: 'acme', name: 'claims', role: 'Damage and loss claims', model: 'claude-opus-5-5' },
  { id: 'globex.kyc', tenantId: 'globex', name: 'kyc', role: 'Identity and onboarding checks', model: 'claude-opus-5-5' },
  { id: 'globex.cards', tenantId: 'globex', name: 'cards', role: 'Card servicing', model: 'claude-sonnet-5' },
  { id: 'globex.fraud', tenantId: 'globex', name: 'fraud', role: 'Disputes and fraud', model: 'claude-opus-5-5' },
  { id: 'initech.onboarding', tenantId: 'initech', name: 'onboarding', role: 'Workspace setup', model: 'claude-haiku-4-5' },
  { id: 'initech.billing', tenantId: 'initech', name: 'billing', role: 'Invoices, credits, budgets', model: 'claude-sonnet-5' },
  { id: 'initech.devsupport', tenantId: 'initech', name: 'devsupport', role: 'Deploys and runtime issues', model: 'claude-opus-5-5' },
]

function user(tenantId: string, id: string, name: string, email: string, extra: Record<string, string> = {}): User {
  const vars = { name, first: name.split(' ')[0], email, uid: id, domain: email.split('@')[1], ...extra }
  return { id, tenantId, name, email, vars }
}

export const USERS: User[] = [
  user('acme', 'C-4821', 'Priya Nair', 'priya.nair@brightcart.io', { order: 'AX-55210', inv: 'INV-88120' }),
  user('acme', 'C-3307', 'Marcus Webb', 'm.webb@tallpine.co', { order: 'AX-54987', inv: 'INV-87954' }),
  user('acme', 'C-5012', 'Lena Ortiz', 'lena@ortizfloral.com', { order: 'AX-55302', inv: 'INV-88311' }),
  user('globex', 'G-10442', 'Tomás Reyes', 'tomas.reyes@mailbox.org', { card: '•••• 4417' }),
  user('globex', 'G-10871', 'Aiko Tanaka', 'aiko.t@fastmail.jp', { card: '•••• 9023' }),
  user('globex', 'G-11205', 'Daniel Okafor', 'd.okafor@outlook.com', { card: '•••• 6650' }),
  user('initech', 'I-2201', 'Sam Patel', 'sam@lumenlabs.dev', { ws: 'ws-lumen' }),
  user('initech', 'I-2388', 'Grace Kim', 'grace.kim@northstar.ai', { ws: 'ws-northstar' }),
  user('initech', 'I-2419', 'Jonas Berg', 'jonas@bergsoft.se', { ws: 'ws-bergsoft' }),
]

export const CHATS: ChatDef[] = [
  { id: 'c-01', tenantId: 'acme', agentId: 'acme.dispatch', userId: 'C-4821' },
  { id: 'c-02', tenantId: 'acme', agentId: 'acme.support', userId: 'C-5012' },
  { id: 'c-03', tenantId: 'acme', agentId: 'acme.claims', userId: 'C-3307' },
  { id: 'c-04', tenantId: 'acme', agentId: 'acme.dispatch', userId: 'C-3307' },
  { id: 'c-05', tenantId: 'globex', agentId: 'globex.kyc', userId: 'G-10442' },
  { id: 'c-06', tenantId: 'globex', agentId: 'globex.cards', userId: 'G-10871' },
  { id: 'c-07', tenantId: 'globex', agentId: 'globex.fraud', userId: 'G-11205' },
  { id: 'c-08', tenantId: 'globex', agentId: 'globex.cards', userId: 'G-10442' },
  { id: 'c-09', tenantId: 'initech', agentId: 'initech.onboarding', userId: 'I-2388' },
  { id: 'c-10', tenantId: 'initech', agentId: 'initech.billing', userId: 'I-2201' },
  { id: 'c-11', tenantId: 'initech', agentId: 'initech.devsupport', userId: 'I-2419' },
  { id: 'c-12', tenantId: 'initech', agentId: 'initech.devsupport', userId: 'I-2201' },
]

// {n} is a per-session number (ticket, claim, dispute ids), the rest come from the user's vars.
export const SCRIPTS: Record<string, Exchange[]> = {
  'acme.dispatch': [
    {
      u: "Where's shipment {order}? It was due yesterday.",
      us: [ok('auth:sso/{uid}', 'session matches {email}'), ok('orders:{order}', 'owner={uid}')],
      a: '{order} is at the Memphis hub. It missed the 02:10 linehaul after a scan fault and is booked on the 14:40 truck. New ETA: tomorrow by 12:00.',
      as: [ok('tracking:{order}/scans', '6 scans, last MEM 03:52'), ok('kb:sla/linehaul-miss')],
    },
    {
      u: 'Can you reroute it to our Nashville warehouse instead? Same account.',
      us: [ok('crm:account/{uid}/addresses', 'Nashville DC-2 on file'), ok('auth:role/{uid}', 'role=shipping_admin')],
      a: 'Reroute filed: {order} goes to Nashville DC-2, 1400 Freight Way. No fee under your contract. Confirmation sent to {email}.',
      as: [ok('orders:{order}/reroute', 'accepted'), ok('billing:contract/{uid}', 'reroute fee waived')],
    },
    {
      u: 'Also, I was told our 3 pallets ship free this month.',
      us: [bad('billing:promo/{uid}', 'no active promo on account'), unk('crm:notes/{uid}', 'no matching note')],
      a: "I can't find a free-shipping promo on your account, and nothing in the notes mentions one. I opened T-{n} for your account manager to confirm before billing runs Friday.",
      as: [ok('ticket:T-{n}', 'assigned to account manager'), bad('billing:promo/{uid}', 'none active')],
    },
    {
      u: 'ok thanks. send me the proof of delivery when it lands',
      us: [ok('auth:sso/{uid}', 'session matches {email}')],
      a: 'Will do. The POD and a signature photo will go to {email} within 15 minutes of delivery.',
      as: [ok('orders:{order}/notify', 'webhook subscribed')],
    },
  ],
  'acme.support': [
    {
      u: 'I got charged twice for invoice {inv}.',
      us: [ok('auth:sso/{uid}', 'session matches {email}'), ok('billing:invoice/{inv}', 'owner={uid}, 2 captures')],
      a: "Confirmed, {inv} was captured twice for $412.80, 41 seconds apart. I've refunded the duplicate. It posts in 3 to 5 business days.",
      as: [ok('ledger:capture/{inv}', '2 captures, 1 refunded'), ok('kb:refunds/duplicate-charge')],
    },
    {
      u: 'The name on our account is spelled wrong, it should be {name}.',
      us: [bad('crm:contact/{uid}', 'CRM has "Lena Ortis"'), ok('auth:idp/{uid}', 'IdP name = {name}')],
      a: 'Your sign-in provider has {name} and the CRM had an old spelling. I updated the CRM to match, so invoices from now on use the new name.',
      as: [ok('crm:contact/{uid}', 'updated'), ok('audit:change/{n}', 'name fix, source=idp')],
    },
    {
      u: 'Can you list the tracking for everything shipped this week?',
      us: [ok('auth:role/{uid}', 'role=account_owner'), ok('orders:list/{uid}?week', '4 shipments')],
      a: '4 shipments this week: {order} in transit, AX-55188 delivered, AX-55190 delivered, AX-55241 out for delivery. Full CSV sent to {email}.',
      as: [ok('orders:list/{uid}'), ok('tracking:batch/4', 'all scans current')],
    },
  ],
  'acme.claims': [
    {
      u: 'Pallet 2 of {order} arrived crushed. Photos attached.',
      us: [ok('orders:{order}/pod', 'signed with exception note'), ok('files:upload/{n}', '3 images, EXIF time matches delivery')],
      a: "The POD has an exception on pallet 2 and your photos are timestamped at delivery. I opened claim CL-{n}. Estimated payout is $1,240, the declared value.",
      as: [ok('claims:CL-{n}', 'opened'), ok('orders:{order}/declared-value', '$1,240 declared')],
    },
    {
      u: 'The declared value was actually $2,000.',
      us: [bad('orders:{order}/declared-value', 'bill of lading says $1,240'), unk('crm:notes/{uid}', 'no note on value')],
      a: "The bill of lading lists $1,240 for pallet 2. If you have a commercial invoice showing $2,000, upload it and I'll send the claim to an adjuster.",
      as: [ok('docs:bol/{order}', 'pallet 2 = $1,240'), ok('policy:claims/declared-value')],
    },
    {
      u: 'uploading the invoice now',
      us: [ok('files:upload/{n}-2', 'invoice PDF, total $2,000.00'), ok('auth:sso/{uid}', 'session matches {email}')],
      a: "Got it. The invoice shows $2,000.00 and the SKU matches the bill of lading. CL-{n} is with an adjuster now, and you'll hear back within 2 business days.",
      as: [ok('claims:CL-{n}/escalation', 'adjuster assigned'), ok('docs:invoice/{n}', 'SKU match')],
    },
  ],
  'globex.kyc': [
    {
      u: "Hi, I'm finishing my account setup. I uploaded my passport.",
      us: [ok('kyc:doc/{uid}/passport', 'MRZ valid, expires 2031'), ok('auth:device/{uid}', 'device bound 2d ago')],
      a: 'The passport checks out: the MRZ is valid and it expires in 2031. Next I need proof of address from the last 3 months.',
      as: [ok('kyc:checklist/{uid}', '2 of 3 complete'), ok('policy:kyc/eu-amld6')],
    },
    {
      u: "Here's a utility bill for my flat in Lisbon.",
      us: [bad('kyc:doc/{uid}/poa', 'address is Lisbon, application says Porto'), ok('crm:application/{uid}', 'address: Porto')],
      a: 'The bill is for Lisbon, but your application says Porto. Which one is current? I can update the application if you moved.',
      as: [ok('crm:application/{uid}'), bad('kyc:doc/{uid}/poa', 'address differs')],
    },
    {
      u: 'I moved last month, Lisbon is right.',
      us: [ok('auth:step-up/{uid}', 'OTP passed'), ok('kyc:doc/{uid}/poa', 'dated within 90 days')],
      a: "Updated the application to Lisbon after your OTP check. KYC is complete and your account opens within the hour.",
      as: [ok('crm:application/{uid}', 'address updated'), ok('kyc:status/{uid}', 'approved')],
    },
  ],
  'globex.cards': [
    {
      u: 'My card {card} got declined at a supermarket.',
      us: [ok('auth:app/{uid}', 'app session, device known'), ok('cards:{uid}/auth-log', 'decline code 05 at 09:14')],
      a: "Card {card} was declined with code 05 because the merchant is in Morocco, which your travel settings block. Should I allow Morocco until 10 Oct?",
      as: [ok('cards:{uid}/geo-controls', 'MA blocked'), ok('kb:cards/decline-codes')],
    },
    {
      u: "Yes please, I'm travelling till the 10th.",
      us: [ok('auth:step-up/{uid}', 'biometric ok'), unk('crm:travel/{uid}', 'no trip on file')],
      a: "Morocco is allowed on {card} until 10 Oct 23:59. I also saved the trip to your profile so charges there won't get flagged.",
      as: [ok('cards:{uid}/geo-controls', 'MA allowed'), ok('crm:travel/{uid}', 'trip saved')],
    },
    {
      u: "What's my current limit?",
      us: [ok('auth:app/{uid}', 'app session, device known'), ok('cards:{uid}/limits')],
      a: 'Your daily limit is €2,500 and €1,860 is left today. The monthly limit is €12,000.',
      as: [ok('cards:{uid}/limits'), ok('ledger:holds/{uid}', '3 pending holds')],
    },
  ],
  'globex.fraud': [
    {
      u: "There's a €389 charge from STEAMGAMES I didn't make.",
      us: [ok('ledger:txn/{uid}/latest', '€389.00 STEAMGAMES.COM'), bad('auth:device/{uid}', 'txn device not in your devices')],
      a: "That charge came from a device that isn't linked to your account. I froze {card} and opened dispute D-{n}. A replacement card is on its way.",
      as: [ok('cards:{uid}/status', 'frozen'), ok('disputes:D-{n}', 'provisional credit issued')],
    },
    {
      u: 'I also shared my card details with someone on a marketplace yesterday.',
      us: [unk('crm:notes/{uid}', 'self-reported, no record'), ok('risk:score/{uid}', 'score 71 → 88')],
      a: "Thanks for telling me. I added that to D-{n}. The new card has a different number and CVV, so the old details won't work anywhere.",
      as: [ok('disputes:D-{n}/notes'), ok('policy:fraud/compromised-card')],
    },
    {
      u: 'Will I get the €389 back?',
      us: [ok('disputes:D-{n}', 'owner={uid}')],
      a: "Yes. A provisional credit of €389.00 is already on your account, and it becomes final when the merchant's 45-day response window closes.",
      as: [ok('ledger:credit/{uid}', '€389.00 provisional'), ok('policy:chargeback/visa-10.4')],
    },
  ],
  'initech.onboarding': [
    {
      u: 'Just signed up, how do I invite my team?',
      us: [ok('auth:sso/{uid}', 'session matches {email}'), ok('crm:workspace/{ws}', 'owner={uid}, seats 1/10')],
      a: 'Go to Settings → Members → Invite. You have 9 of 10 seats free. Should I send the invites if you paste the emails here?',
      as: [ok('kb:onboarding/invite-members'), ok('billing:plan/{ws}', 'pro, 10 seats')],
    },
    {
      u: 'yes: dev1@{domain}, dev2@{domain}',
      us: [ok('auth:domain/{ws}', '{domain} verified via DNS')],
      a: "Sent 2 invites. They're approved automatically because {domain} is a verified domain on {ws}.",
      as: [ok('invites:{ws}', '2 pending'), ok('audit:invite/{n}')],
    },
    {
      u: "We're on the enterprise plan btw, we need SAML.",
      us: [bad('billing:plan/{ws}', 'plan=pro'), unk('crm:opportunity/{ws}', 'open deal, not signed')],
      a: '{ws} is on Pro right now, and SAML needs Enterprise. There is an open Enterprise deal on your account, so I pinged your account exec to finish it.',
      as: [ok('crm:opportunity/{ws}', 'AE notified'), ok('kb:sso/saml-requirements')],
    },
  ],
  'initech.billing': [
    {
      u: 'Why did our bill jump to $840 this month?',
      us: [ok('auth:sso/{uid}', 'session matches {email}'), ok('billing:invoice/{ws}/2026-09', '$840.00')],
      a: 'Compute went from 1.2k to 4.9k vCPU-hours, mostly the etl-nightly job from 14 to 19 Sep. Seats and storage did not change.',
      as: [ok('usage:{ws}/compute', '+308% month over month'), ok('billing:invoice/{ws}/2026-09')],
    },
    {
      u: 'that job was stuck in a retry loop, can we get a credit?',
      us: [ok('usage:{ws}/jobs/etl-nightly', '212 retries, exit 137'), ok('policy:credits/runaway-jobs')],
      a: 'The retry storm is in the logs: 212 retries, all OOM kills. That qualifies under the runaway-job policy, so I applied a $590 credit.',
      as: [ok('billing:credit/{ws}', '$590.00 applied'), ok('audit:credit/{n}')],
    },
    {
      u: 'Can you cap spend at $400 a month going forward?',
      us: [ok('auth:role/{uid}', 'role=billing_admin')],
      a: 'Done. {ws} now has a $400/month hard cap, with alerts at 50%, 80% and 100% sent to {email}.',
      as: [ok('billing:budget/{ws}', '$400 hard cap'), ok('notify:{ws}/budget', '3 alerts')],
    },
  ],
  'initech.devsupport': [
    {
      u: "Our deploys started failing with 'x509: certificate signed by unknown authority'",
      us: [ok('auth:sso/{uid}', 'session matches {email}'), ok('deploys:{ws}/latest', '3 failed since 08:12')],
      a: "The runners picked up a new base image at 08:10 that drops your private CA bundle. Pin runner-image@2026.09.2 or mount the CA from your secrets store.",
      as: [ok('changelog:runner-image/2026.09.3', 'CA store reset'), ok('kb:deploys/custom-ca')],
    },
    {
      u: 'pinned it, still failing on one service',
      us: [ok('deploys:{ws}/svc-billing', 'still failing'), bad('config:{ws}/svc-billing', 'pin not applied, override in service.yaml')],
      a: 'svc-billing has its own runner: override in service.yaml that skips the workspace pin. Remove line 14 or pin the image there too.',
      as: [ok('config:{ws}/svc-billing/service.yaml', 'line 14 override'), ok('deploys:{ws}/svc-billing')],
    },
    {
      u: 'green now, thanks',
      us: [ok('deploys:{ws}/svc-billing', 'passing')],
      a: "Good to hear. I subscribed {ws} to runner-image release notes so you get a heads-up before the next CA change.",
      as: [ok('notify:{ws}/changelog', 'subscribed')],
    },
  ],
}

export const TENANT = Object.fromEntries(TENANTS.map((t) => [t.id, t]))
export const AGENT = Object.fromEntries(AGENTS.map((a) => [a.id, a]))
export const USER = Object.fromEntries(USERS.map((u) => [u.id, u]))
