import { InAppMessagingManager } from './inapp';

/**
 * A message with nothing to render must not be displayed, and must not be
 * reported as displayed.
 *
 * Reported 2026-08-16 as "the message never appears": the SDK found no usable
 * HTML, and then carried on anyway - injecting an empty invisible frame,
 * consuming the frequency cap, and posting an `in_app.displayed` impression.
 *
 * The impression is the damaging half. A delivery failure that reports itself
 * as a successful delivery is invisible in analytics, so nobody investigates;
 * the campaign looks like it is working. Counting non-events is worse than
 * counting nothing.
 *
 * These tests drive the real showMessage() path with the network and DOM
 * stubbed, so they assert BEHAVIOUR (did anything render, was anything
 * tracked) rather than the presence of a guard clause.
 */
describe('a campaign that renders no content', () => {
  const stubLogger = { error() {}, warn() {}, info() {}, debug() {} } as any;

  /** Minimal campaign shape; `content` is what varies per case. */
  const campaign = (content: unknown) =>
    ({
      id: 'camp-empty',
      name: 'empty',
      triggers: [{ type: 'immediate' }],
      content,
    }) as any;

  function make() {
    const m = new InAppMessagingManager(
      'https://api.example',
      'jry_sdk_test',
      {} as any,
      {} as any,
      stubLogger,
    );
    const tracked: string[] = [];
    // Record impressions instead of performing them.
    (m as any).trackImpression = async (_id: string, event: string) => {
      tracked.push(event);
    };
    const displayed: unknown[] = [];
    (m as any).display = (msg: unknown) => {
      displayed.push(msg);
    };
    // Frequency cap and eligibility are not what these tests are about.
    (m as any).checkFrequencyCap = () => true;
    // HTML messages run author-supplied JavaScript on the host page, so an
    // integration must opt in (allowHtmlJsInAppMessages) before the SDK draws
    // one. These tests are about EMPTY content, not the opt-in, so opt in.
    (m as any).allowHtmlJsInAppMessages = true;
    return { m, tracked, displayed };
  }

  const EMPTY_CASES: Array<[string, unknown]> = [
    ['no content field at all', undefined],
    ['an empty html string', { kind: 'html', html: '', css: '' }],
    ['whitespace-only html', { kind: 'html', html: '   \n\t ', css: '' }],
    // The web SDK renders `html` and (since the native templates) `native`.
    // Any other kind reaching it is a server-side routing mistake, and it
    // must fail closed, not display an empty box and claim an impression.
    ['a kind this SDK cannot render', { kind: 'carousel', body: 'hi' }],
  ];

  it.each(EMPTY_CASES)('does not display or track for %s', async (_label, content) => {
    const { m, tracked, displayed } = make();

    await (m as any).displayCampaign(campaign(content));

    expect(displayed).toEqual([]);
    expect(tracked).toEqual([]);
  });

  it('leaves the campaign eligible rather than burning the frequency cap', async () => {
    // The bug consumed the cap on a message nobody saw, so a corrected payload
    // would have been suppressed as "already shown".
    const { m } = make();

    await (m as any).displayCampaign(campaign({ kind: 'html', html: '', css: '' }));

    expect((m as any).impressionTimestamps.get('camp-empty')).toBeUndefined();
    expect((m as any).displayedMessages.get('camp-empty')).toBeUndefined();
  });

  it('still displays and tracks when there IS content', async () => {
    // The guard must not be so eager that it suppresses real messages - that
    // would trade a visible bug for a silent one.
    const { m, tracked, displayed } = make();

    await (m as any).displayCampaign(campaign({ kind: 'html', html: '<p>hi</p>', css: '' }));

    expect(displayed).toHaveLength(1);
    expect(tracked).toEqual(['displayed']);
  });
});
