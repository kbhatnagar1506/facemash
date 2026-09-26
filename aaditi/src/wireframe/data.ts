// One user account, many agents talking to other people and bots on that user's behalf.
// Every message records which of the user's info was shared or checked, and against what source.

export type Result = 'verified' | 'mismatch' | 'unverified' | 'pending'
export type Check = { info: string; result: Result; note: string }
export type From = 'agent' | 'them' | 'system' | 'you'
export type Line = { from: From; min: number; text: string; checks?: Check[] }
export type Status = 'needs-you' | 'active' | 'waiting' | 'done'
export type Thread = {
  id: string
  agent: string
  counterparty: string
  party: 'bot' | 'human'
  channel: string
  goal: string
  status: Status
  typing?: boolean
  lines: Line[]
  approval?: { ask: string; info: string; yes: string; no: string }
}
export type Info = { id: string; label: string; value: string; source: string; verifiedMin: number }

export const ACCOUNT = { name: 'Priya Nair', email: 'priya.nair@gmail.com', plan: 'Personal account', initials: 'PN' }

const v = (info: string, note: string): Check => ({ info, result: 'verified', note })
const x = (info: string, note: string): Check => ({ info, result: 'mismatch', note })
const u = (info: string, note: string): Check => ({ info, result: 'unverified', note })
const p = (info: string, note: string): Check => ({ info, result: 'pending', note })

export const INFO: Info[] = [
  { id: 'name', label: 'Full name', value: 'Priya Nair', source: 'passport scan', verifiedMin: 60 * 24 * 30 },
  { id: 'email', label: 'Email', value: 'priya.nair@gmail.com', source: 'Google account', verifiedMin: 60 * 24 * 2 },
  { id: 'address', label: 'Home address', value: '1140 Peachtree St NE, Apt 1207, 30308', source: 'lease PDF + USPS', verifiedMin: 60 * 24 * 9 },
  { id: 'card', label: 'Card', value: 'Visa •••• 4417', source: 'Apple Wallet', verifiedMin: 60 * 5 },
  { id: 'bank', label: 'Bank feed', value: 'Chase checking •••• 0921', source: 'Plaid link', verifiedMin: 4 },
  { id: 'passport', label: 'Passport', value: '•••• 8821, exp 2031', source: 'ID scan', verifiedMin: 60 * 24 * 30 },
  { id: 'skymiles', label: 'SkyMiles', value: '•••• 4410', source: 'Delta account link', verifiedMin: 60 * 24 },
  { id: 'prefs', label: 'Travel preferences', value: 'aisle, Comfort+ under $100', source: 'your profile', verifiedMin: 60 * 24 * 60 },
  { id: 'insurance', label: 'Dental insurance', value: 'Aetna PPO •••• 3321', source: 'insurance card scan', verifiedMin: 60 * 24 * 90 },
  { id: 'calendar', label: 'Calendar', value: 'Google Calendar', source: 'OAuth, read + hold', verifiedMin: 1 },
  { id: 'lease', label: 'Lease', value: 'Apt 1207, ends 31 Oct 2026', source: 'Google Drive', verifiedMin: 60 * 24 * 9 },
  { id: 'receipts', label: 'Order receipts', value: 'Gmail, label: Receipts', source: 'Gmail read-only', verifiedMin: 20 },
  { id: 'utility', label: 'Comcast account', value: '•••• 7730', source: 'Comcast login', verifiedMin: 7 },
  { id: 'notes', label: 'Your notes', value: '14 notes', source: 'written by you', verifiedMin: 60 * 24 },
]

export const THREADS: Thread[] = [
  {
    id: 't1',
    agent: 'Travel agent',
    counterparty: 'Delta virtual assistant',
    party: 'bot',
    channel: 'web chat',
    goal: 'Rebook cancelled DL1423 ATL → SFO',
    status: 'needs-you',
    lines: [
      { from: 'system', min: 38, text: 'Delta cancelled DL1423 (email 06:12). Travel agent started rebooking.' },
      {
        from: 'agent',
        min: 36,
        text: "Hi, I'm rebooking for passenger Priya Nair, confirmation HX7Q2L. DL1423 was cancelled this morning.",
        checks: [v('name', 'matches passport scan'), v('skymiles', 'HX7Q2L is on this SkyMiles account')],
      },
      {
        from: 'them',
        min: 35,
        text: 'Thanks Priya. I can move you to DL1587 at 14:05 today or DL911 tomorrow at 07:30, both at no charge.',
        checks: [v('calendar', 'free 13:00–22:00 today')],
      },
      {
        from: 'agent',
        min: 33,
        text: 'DL1587 please. She prefers an aisle seat. Is Comfort+ available?',
        checks: [v('prefs', 'aisle, Comfort+ under $100')],
      },
      {
        from: 'them',
        min: 31,
        text: 'Comfort+ 14C on DL1587 is available for an $84 fare difference.',
        checks: [p('card', 'over the $50 auto-pay limit, needs you')],
      },
      { from: 'system', min: 30, text: 'Paused: paying $84 is above what this agent may spend without asking.' },
    ],
    approval: {
      ask: 'Pay $84 for Comfort+ seat 14C on DL1587 with Visa •••• 4417?',
      info: 'card',
      yes: 'Please go ahead with 14C and charge the card ending 4417.',
      no: "She'll keep a standard aisle seat on DL1587, thanks.",
    },
  },
  {
    id: 't3',
    agent: 'Finance agent',
    counterparty: 'Chase card services',
    party: 'bot',
    channel: 'web chat',
    goal: 'Dispute $389 STEAMGAMES charge',
    status: 'active',
    typing: true,
    lines: [
      {
        from: 'agent',
        min: 14,
        text: "Disputing a $389.00 charge from STEAMGAMES.COM on 24 Sep, card ending 4417. The cardholder didn't make it.",
        checks: [v('card', 'card in Apple Wallet'), v('bank', 'txn found 24 Sep 23:41'), v('name', 'cardholder name matches')],
      },
      { from: 'them', min: 13, text: 'For security, please confirm the billing ZIP code.' },
      { from: 'agent', min: 12, text: '30308.', checks: [v('address', 'ZIP from lease, confirmed by USPS')] },
      { from: 'them', min: 11, text: 'Confirmed. Did the cardholder share the card details with anyone?' },
      { from: 'agent', min: 10, text: 'No.', checks: [u('notes', 'no record either way, answered from your note of 25 Sep')] },
      {
        from: 'them',
        min: 2,
        text: 'Dispute D-5521 is open. A provisional credit will post in 1–2 business days.',
        checks: [p('bank', 'watching the feed for the credit')],
      },
    ],
  },
  {
    id: 't6',
    agent: 'Bills agent',
    counterparty: 'Comcast (Xfinity) chat',
    party: 'bot',
    channel: 'web chat',
    goal: 'Get internet back under $60/mo',
    status: 'active',
    typing: true,
    lines: [
      {
        from: 'agent',
        min: 6,
        text: 'Account holder Priya Nair, account ending 7730. Her bill went from $55 to $80. AT&T offers 500 Mbps for $55 at her address. Can you match it?',
        checks: [v('utility', 'logged in as the account holder'), v('address', 'service address matches'), v('bills', 'AT&T quote for 30308, captured 6 min ago')],
      },
      { from: 'them', min: 3, text: 'I can offer $62/mo for 12 months.' },
    ],
  },
  {
    id: 't5',
    agent: 'Shopping agent',
    counterparty: 'Zara returns assistant',
    party: 'bot',
    channel: 'web chat',
    goal: 'Return wool jacket, order ZR-88213',
    status: 'active',
    lines: [
      {
        from: 'agent',
        min: 22,
        text: 'Starting a return for order ZR-88213, wool jacket, size M.',
        checks: [v('receipts', 'receipt 12 Sep, $129.00'), v('email', 'order email matches account')],
      },
      {
        from: 'them',
        min: 21,
        text: 'This item is outside the 30-day return window.',
        checks: [x('receipts', 'delivered 14 Sep, 12 days ago, inside 30 days')],
      },
      {
        from: 'agent',
        min: 20,
        text: 'The delivery confirmation says 14 Sep, which is 12 days ago. Could you check again?',
        checks: [v('receipts', 'UPS delivery email, 14 Sep 15:20')],
      },
      {
        from: 'them',
        min: 1,
        text: 'Apologies, the return is approved. A prepaid label is on its way to your email.',
        checks: [p('email', 'waiting for the label in the inbox')],
      },
    ],
  },
  {
    id: 't7',
    agent: 'Career agent',
    counterparty: 'Jordan Lee, recruiter at Stripe',
    party: 'human',
    channel: 'LinkedIn',
    goal: 'Schedule the onsite interview',
    status: 'needs-you',
    lines: [
      { from: 'them', min: 70, text: "Hi Priya, we'd love to bring you onsite. Does Oct 7 or Oct 8 work?" },
      {
        from: 'agent',
        min: 60,
        text: 'Hi Jordan, I handle scheduling for Priya. She is free all day Oct 7 and after 13:00 on Oct 8.',
        checks: [v('calendar', 'Oct 7 free, Oct 8 busy until 12:30')],
      },
      {
        from: 'them',
        min: 25,
        text: "Great, let's do Oct 7 at 10:00. Could she also share her salary expectations?",
        checks: [v('calendar', 'hold placed Oct 7 10:00–15:00')],
      },
      { from: 'system', min: 24, text: 'Paused: salary expectations are outside what this agent may share.' },
    ],
    approval: {
      ask: 'Share your salary range ($185k–200k, from your notes) with Jordan?',
      info: 'notes',
      yes: 'Oct 7 at 10:00 is confirmed. Her base salary range is $185k–200k.',
      no: "Oct 7 at 10:00 is confirmed. She'd like to discuss compensation with you directly.",
    },
  },
  {
    id: 't2',
    agent: 'Housing agent',
    counterparty: 'Mark Ellis, landlord',
    party: 'human',
    channel: 'email',
    goal: 'Renew lease, keep rent under $2,150',
    status: 'waiting',
    lines: [
      {
        from: 'agent',
        min: 190,
        text: "Hi Mark, I'm writing for Priya Nair about Apt 1207. The lease ends 31 Oct and she'd like to renew for 12 months.",
        checks: [v('name', 'tenant name on lease'), v('address', 'unit matches lease'), v('lease', 'ends 2026-10-31')],
      },
      {
        from: 'them',
        min: 120,
        text: 'Happy to renew at $2,290. Note that rent was late in March.',
        checks: [x('bank', '$2,050 paid 1 Mar 08:02, before the 5th'), v('lease', 'late only after the 5th')],
      },
      {
        from: 'agent',
        min: 115,
        text: 'Her records show March rent of $2,050 cleared on 1 March, before the due date. With 12 of 12 payments on time, would you consider $2,120?',
        checks: [v('bank', '12 of 12 payments on time')],
      },
      { from: 'them', min: 8, text: "Let me check the ledger on my side and I'll come back to you." },
    ],
  },
  {
    id: 't4',
    agent: 'Health agent',
    counterparty: 'Midtown Dental front desk',
    party: 'human',
    channel: 'SMS',
    goal: 'Book a cleaning, first week of Oct',
    status: 'done',
    lines: [
      {
        from: 'agent',
        min: 55,
        text: "Hi, this is an assistant booking for Priya Nair. She's due for a cleaning. Any openings Oct 1–3?",
        checks: [v('name', 'patient on file'), v('insurance', 'Aetna PPO, in network')],
      },
      {
        from: 'them',
        min: 40,
        text: 'We have Oct 2 at 9:30 or Oct 3 at 16:00.',
        checks: [v('calendar', 'Oct 2 9:30 free, Oct 3 16:00 clashes with a 1:1')],
      },
      {
        from: 'agent',
        min: 38,
        text: 'Oct 2 at 9:30 works. Her insurance is Aetna, member ID ending 3321.',
        checks: [v('insurance', 'member ID from card scan'), v('calendar', 'hold placed')],
      },
      { from: 'them', min: 5, text: 'Booked! Please arrive 10 minutes early.', checks: [v('calendar', 'event confirmed')] },
    ],
  },
  {
    id: 't8',
    agent: 'Subscriptions agent',
    counterparty: 'Adobe support assistant',
    party: 'bot',
    channel: 'web chat',
    goal: 'Cancel Creative Cloud without a fee',
    status: 'done',
    lines: [
      {
        from: 'agent',
        min: 240,
        text: 'Please cancel Creative Cloud for priya.nair@gmail.com. It is an annual plan billed monthly.',
        checks: [v('email', 'Adobe ID matches'), v('card', '$59.99 charged monthly')],
      },
      { from: 'them', min: 238, text: 'Cancelling now carries an early termination fee of $179.94.' },
      {
        from: 'agent',
        min: 236,
        text: 'The plan renewed on 20 Sep, which is within 14 days, so under your terms she can cancel with no fee.',
        checks: [v('bank', 'renewal charge 20 Sep')],
      },
      {
        from: 'them',
        min: 230,
        text: "You're right. Cancelled with no fee, and $59.99 is refunded.",
        checks: [p('bank', 'refund not in the feed yet')],
      },
    ],
  },
]

// Not every check is against a stored info item; a live quote the agent fetched counts as its own source.
export const EXTRA_SOURCES: Record<string, string> = { bills: 'Live quote' }

export const infoLabel = (id: string) => INFO.find((i) => i.id === id)?.label ?? EXTRA_SOURCES[id] ?? id
