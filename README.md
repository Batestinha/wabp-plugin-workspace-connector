# Integration Manager

Connects the bot to its Workspace, handles account registration and linking through /register, and delivers requests, replies and account notices for enabled integrations.

Integration Manager connects WABP to Workspace, publishes scoped memberships, and runs one delivery poller per account runtime. It owns the shared machine credential, sessions, staged media, retries and delivery receipts. Enable the connection in the required scopes. The **Website account access** switch enables registration, account linking, and sensitive WhatsApp sign-in and recovery messages. Turning off the last participating scope stops pending code delivery.

Use `/register` for website registration and `/workspace status` to inspect the connection. Compatibility commands such as `/workspace gallery` require the same enabled app, scope, membership and authenticated catalog entry as the native command. **Piwigo** owns `/gallery`. **Calendar** accepts projections from Community Events. **Chat Archive** controls external access, links and notices.

Upgrade from `official.workspace-connector` with the coordinated WABP cutover. The previous dependency and projection service remain available during migration. Existing data keys, staged payloads, provider message IDs and delivery receipts carry forward.

The account's Global settings control OTP formatting where available. Otherwise participating scopes must agree. The sensitive delivery service retains its existing acknowledgement and replay rules.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. The release includes the pinned SDK, Workspace contracts, translations and runtime dependencies.
