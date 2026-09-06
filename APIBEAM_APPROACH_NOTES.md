# Notes on ApiBeam’s Extension-Based Approach

## Why consider this approach?

In the past, I used Playwright to automate a website and crawl data. It worked for small runs, but repeated automation—especially more than 100 requests—started to fail. Typical causes include:

- browser sessions expiring or requiring re-authentication;
- rate limits, bot-detection controls, CAPTCHAs, or temporary account restrictions;
- page selectors changing after a site update;
- timing problems while waiting for dynamic content to load;
- memory, browser-process, or connection instability in long-running jobs.

ApiBeam takes a different approach. Instead of driving a browser from outside with Playwright, it installs a browser extension inside a browser where the user is already signed in. The extension receives a request over a WebSocket connection, inserts the request into ChatGPT, Claude, or z.ai, waits for the web app’s response, and returns the result through the relay server.

```text
Application
  -> ApiBeam relay server
  -> WebSocket connection
  -> Browser extension in an authenticated browser session
  -> ChatGPT / Claude / z.ai web interface
  -> Response returned through the same relay
```

## How it differs from Playwright

| Playwright crawling | ApiBeam extension |
| --- | --- |
| External script controls the browser through automation APIs. | Extension runs in the browser and interacts with a site directly. |
| Each job often needs browser startup, login-state management, navigation, and selector waiting. | Uses the browser’s existing signed-in session and a persistent WebSocket connection. |
| Long runs can fail from automation detection, stale selectors, timeouts, or resource exhaustion. | Avoids some external automation overhead, but still depends on fragile page selectors and the provider’s web UI. |
| Best suited to permitted website testing or data extraction where automation is allowed. | Intended to turn an AI web session into an informal API; it is not an official provider API. |

## Potential benefit for repeated requests

The extension can reduce some of the operational problems seen with repeated Playwright jobs:

- The browser remains open and authenticated instead of being repeatedly launched and driven.
- The extension keeps a persistent connection to its relay server.
- Requests can be sent one at a time through the same active session.
- It captures streamed AI responses from the site rather than relying only on DOM scraping.

However, it does **not** eliminate provider limits. Sending more than 100 requests can still trigger rate limits, account restrictions, UI changes, session expiration, or service-side reliability problems. A queue, conservative rate limiting, retries with backoff, request timeouts, and response validation are still necessary.

## Security and privacy limitations

This repository should not be treated as a secure replacement for an official API:

- Its default configuration uses the hosted `apibeam.bitsmall.in` relay. Prompts and captured responses travel through that service.
- The relay can instruct the extension to submit prompts through the signed-in account.
- The current ChatGPT integration writes relay-provided text with `innerHTML`, which is an unsafe implementation detail.
- The extension has no strong visible end-to-end authentication protocol for relay requests.
- The project has limited maintenance safeguards: no automated test suite, CI workflow, signed releases, or security policy were found.

Therefore, do not send credentials, private documents, customer data, health data, financial data, or production secrets through the default setup.

## Recommended position

Use this only as a **low-risk prototype** in a separate browser profile with a non-sensitive test account. If this architecture is needed for a real workflow:

1. Prefer the provider’s official API whenever it meets the requirement.
2. Self-host and review the backend rather than using the default relay.
3. Fix the unsafe HTML insertion and validate every incoming request.
4. Add authentication, authorization, per-request logging, rate limits, retries, and a queue.
5. Treat website UI automation as inherently fragile and ensure the workflow complies with the provider’s terms.

## Conclusion

ApiBeam can be easier to operate than repeatedly launching Playwright for an already-authenticated AI web session. It may reduce browser-automation failures, but it trades those failures for security, privacy, maintenance, and policy risks. It is suitable for experimentation, not a production-grade or trusted API bridge in its current form.
