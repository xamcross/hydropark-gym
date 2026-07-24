/** The features the tour spotlights, in order. Each id matches a `[tourAnchor]` in the shell. */
export type TourAnchorId = 'chat' | 'panels' | 'speed' | 'marketplace' | 'templates' | 'account';

/** How a step advances: a plain Next, or the one hands-on "magic beat". */
export type TourAdvance = 'next' | 'magic';

export interface TourStep {
  readonly id: TourAnchorId;
  readonly title: string;
  readonly body: string;
  readonly advance: TourAdvance;
}

/** The exact prompt the magic beat sends. Must contain "carbonara": the mock
 *  inference engine only runs tools for that prompt (see the E2E chat scenario
 *  and the chat empty-state hint). */
export const MAGIC_PROMPT = 'Help me cook carbonara for 4';

/** How the tour drives the real chat composer for the magic beat. Registered by ChatComponent. */
export interface TourChatBridge {
  prefill(text: string): void;
  send(): void;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'chat',
    advance: 'magic',
    title: 'Talk to your agent',
    body: `This is your offline agent — ask in plain language and it acts, it doesn't just chat. We've typed a request for you. Send it and watch.`,
  },
  {
    id: 'panels',
    advance: 'next',
    title: 'The agent’s live workspace',
    body: `It just turned your words into these panels — an ingredient list and a running timer. They're live: edit them directly and the agent keeps up.`,
  },
  {
    id: 'speed',
    advance: 'next',
    title: 'It all ran on your machine',
    body: `That came from a model running locally — nothing left your device. This is the real speed, measured live as you go.`,
  },
  {
    id: 'marketplace',
    advance: 'next',
    title: 'Add new skills',
    body: `Give your agent new abilities here — browse and install skills from the Marketplace.`,
  },
  {
    id: 'templates',
    advance: 'next',
    title: 'One-click setups',
    body: `Templates pre-arrange skills for a task, so you can start in one click instead of setting things up by hand.`,
  },
  {
    id: 'account',
    advance: 'next',
    title: 'Optional account',
    body: `Sign in only if you want licenses and paid skills synced. Hydropark works fully offline without an account.`,
  },
];
