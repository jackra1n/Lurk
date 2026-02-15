# Changelog

## [1.0.3](https://github.com/jackra1n/Lurk/compare/1.0.2...1.0.3) (2026-02-15)


### Features

* add login watcher change detection ([3666b05](https://github.com/jackra1n/Lurk/commit/3666b05c22a77c387f842f8c1e498ae5e1814624))
* add watch_started/watch_stopped events and expose runtime balances ([cd53a65](https://github.com/jackra1n/Lurk/commit/cd53a65662501221b79090fc8ce1864b2dfbcbfc))
* track streamer watch events and runtime balances ([b2f50cb](https://github.com/jackra1n/Lurk/commit/b2f50cb8810a99362b7d6e9d23868579bb209103))


### Documentation

* update local access port in readme ([fd30701](https://github.com/jackra1n/Lurk/commit/fd3070168961599daac059d23d44ceba42f73500))


### Refactoring

* stop logging specific events ([0cc6000](https://github.com/jackra1n/Lurk/commit/0cc60008637c87fa08e4558a7b8b75836216322e))


### Miscellaneous

* adjust release version ([5b8f367](https://github.com/jackra1n/Lurk/commit/5b8f3674e1b41c049df9cc31d78e8fb5945cfc7c))

## [1.0.2](https://github.com/jackra1n/Lurk/compare/1.0.1...1.0.2) (2026-02-14)


### Bug Fixes

* release please config (finally read the correct doc) ([6212ab8](https://github.com/jackra1n/Lurk/commit/6212ab861f57a2880769d56683527749e89fcc69))


### CI/CD

* adds arm64 build support ([8c4303b](https://github.com/jackra1n/Lurk/commit/8c4303b66f7ec425b8bce38ea35db5e7d636b14a))

## [1.0.1](https://github.com/jackra1n/Lurk/compare/lurk-v1.0.0...lurk-1.0.1) (2026-02-14)


### Bug Fixes

* update release tag format ([c521a65](https://github.com/jackra1n/Lurk/commit/c521a65429a99d7e89443987f5c98c9f2e29920b))
* update release tag format ([9f746fc](https://github.com/jackra1n/Lurk/commit/9f746fc80e414049731a83a8f16c3ac50ca892f9))

## [1.0.0](https://github.com/jackra1n/Lurk/compare/lurk-v0.0.1...lurk-v1.0.0) (2026-02-13)


### Features

* add 'Last Watched' sort option for streamers ([ab73735](https://github.com/jackra1n/Lurk/commit/ab7373523f36fb7db0e45c2db5624148f50fa783))
* add alert shadcn component ([7044890](https://github.com/jackra1n/Lurk/commit/7044890fbee1073b5afc7f92a6f9afba8ad36985))
* add and setup tailwindcss and shadcn-svelte ([4cccd4c](https://github.com/jackra1n/Lurk/commit/4cccd4cb7b954f0a0831da88314f5e73c0dbc0f9))
* add Badge, Button, and Card shadcn components ([f261da1](https://github.com/jackra1n/Lurk/commit/f261da1941151a7aa82e83d2d9e552ab03289a40))
* add footer with GitHub link ([ce4319a](https://github.com/jackra1n/Lurk/commit/ce4319a4d41d17722cf3969e1ba8dc4c6a36887d))
* add health check endpoint ([95094a5](https://github.com/jackra1n/Lurk/commit/95094a57318f76b5588cbfa39a4b29571a445dab))
* add initial Docker support and example compose setup ([c126254](https://github.com/jackra1n/Lurk/commit/c1262547273b5cfc42ee89a63b0a8145a6de0fbe))
* add initial frontend ([29d0918](https://github.com/jackra1n/Lurk/commit/29d0918fdceb71e6ff263a6de7c263f4c36e87b2))
* add initial graph card of streamer points history ([fb0b8b9](https://github.com/jackra1n/Lurk/commit/fb0b8b969547e318c5c0be780030fb1b37760c95))
* add live channel count to tracked channels card ([a84eaa6](https://github.com/jackra1n/Lurk/commit/a84eaa6b4ca7fa73ed35aedc0a538f98779c6077))
* add logging with file rotation ([536da39](https://github.com/jackra1n/Lurk/commit/536da390025fc6dfda8f1032f6d59d6c3d6d20ae))
* add miner stop confirmation dialog ([c5d344e](https://github.com/jackra1n/Lurk/commit/c5d344eb4aff10e1735e34d582ab61e9f7cf2721))
* add pino dependency ([3b50c63](https://github.com/jackra1n/Lurk/commit/3b50c633adbba69b6ce838d6543f2742e341ab99))
* add preset date range options for channel points ([47e5509](https://github.com/jackra1n/Lurk/commit/47e55094da74bf085516828e693e34420eee1c53))
* add RangeCalendar shadcn component ([9b14671](https://github.com/jackra1n/Lurk/commit/9b146714e0b728cebded1e9cdd19644587ffafb5))
* add Scroll Area, Input and Calendar shadcn components ([3e0170f](https://github.com/jackra1n/Lurk/commit/3e0170f73135dd09430502f45ecfdb7b71d45dc2))
* add SvelteKit Bun adapter ([5bec7f7](https://github.com/jackra1n/Lurk/commit/5bec7f7da873483a863a5c195b2c685eca5f833c))
* add Tooltip and Dialog shadcn components ([a3d161a](https://github.com/jackra1n/Lurk/commit/a3d161a5f629ee9c92fb7b5505968d62d11a32a8))
* add vite plugin for server-side startup ([80b5648](https://github.com/jackra1n/Lurk/commit/80b56485b00ffd5e60c050f33eeaf451d10bd748))
* **auth:** add topbar authentication control ([ce0af3e](https://github.com/jackra1n/Lurk/commit/ce0af3e2da8350982be7c6d89582c2ed9fd9ebf1))
* **config:** add option to disable miner auto-start ([b260a84](https://github.com/jackra1n/Lurk/commit/b260a84823ddbac9dea28b749c657e45f2b4cd2c))
* **dashboard:** add channel points analytics API ([cfccc5e](https://github.com/jackra1n/Lurk/commit/cfccc5e9a6a010b16a89f0ec488de9c399e0316f))
* **dashboard:** add dynamic frontend and authentication ([8d815a4](https://github.com/jackra1n/Lurk/commit/8d815a4a3abe73d7506bb8c3f9b095c36c3e5e8d))
* **dashboard:** add priority sorting for streamer ([e6b7c42](https://github.com/jackra1n/Lurk/commit/e6b7c4261e67783c0e4c32ca57f24fbdb411d5a1))
* **dashboard:** improve miner status dot clarity ([6a58e26](https://github.com/jackra1n/Lurk/commit/6a58e26e9a2864a4bd539886738d3f0773398eb6))
* **dashboard:** show streamer runtime status ([3220e94](https://github.com/jackra1n/Lurk/commit/3220e948c257e727c35bc00c003efc905f131a40))
* **database:** add Drizzle ORM and Drizzle Kit ([4cdf6c5](https://github.com/jackra1n/Lurk/commit/4cdf6c53e09aa23b63d29350633abd04cea76ac9))
* **db:** add initial database schema ([2138fb4](https://github.com/jackra1n/Lurk/commit/2138fb43eb5e0f06bcd9382acae8a1ed5d57f1a4))
* **db:** set up SQLite database with Drizzle ([f3e2bf1](https://github.com/jackra1n/Lurk/commit/f3e2bf1705e36f9f249f9f9a24551b967bb0d9a0))
* display selected streamer balance ([175da02](https://github.com/jackra1n/Lurk/commit/175da02c62a9173286b78a0880f7ff507b02ef10))
* implement miner start/stop quick actions ([8a8d526](https://github.com/jackra1n/Lurk/commit/8a8d526b56d4fd6c8d9ead17014bc019e49b0fe0))
* implement miner start/stop quick actions ([080ffc2](https://github.com/jackra1n/Lurk/commit/080ffc25538497b498ce6f2a9842882266d0b676))
* improve GQL request stability ([9b7fe83](https://github.com/jackra1n/Lurk/commit/9b7fe834b9d0729c8a753ff8c938d34a9c7a603f))
* improve live status tracking and stream data ([8dba5dc](https://github.com/jackra1n/Lurk/commit/8dba5dce68f24fcdd28f25c4dd0b60b73ea34edc))
* improve logging ([0beca5c](https://github.com/jackra1n/Lurk/commit/0beca5c27e78eeb835e44ae74aab05053348658c))
* improve startup results and lifecycle status ([5070770](https://github.com/jackra1n/Lurk/commit/5070770d42c73a0eeee04ee8f5e4b1f01f3c04f6))
* improve streamer list sorting by last active and last watched ([462a1a4](https://github.com/jackra1n/Lurk/commit/462a1a407a7ba06aef7736802d33f58524ad315f))
* make data paths configurable ([5789c28](https://github.com/jackra1n/Lurk/commit/5789c28a965c86bd71dcdafcb1dd4065590497a0))
* **miner:** add event tracking for analytics ([f62abe9](https://github.com/jackra1n/Lurk/commit/f62abe962db4e746db872b302ac8453842b61d8c))
* **miner:** add initial miner backend ([4aa56fb](https://github.com/jackra1n/Lurk/commit/4aa56fbb930dd477d5020215b26a10ee0f39daac))
* **miner:** add minute-watched event sending ([d0bfb63](https://github.com/jackra1n/Lurk/commit/d0bfb63d91383b60bd94a3008ba035340f1ff180))
* persist authentication data in dedicated file ([6991b83](https://github.com/jackra1n/Lurk/commit/6991b83cc292eb3240ad500b67736e844fa7b0c9))
* set up ci/cd workflows ([e098302](https://github.com/jackra1n/Lurk/commit/e098302a345188db7f31df2ef974b0e2a7557d3c))
* set up ci/cd workflows ([8ba1725](https://github.com/jackra1n/Lurk/commit/8ba17257a198cb8c2905f53779b877405be4ee67))
* show distinct miner starting state ([62d73da](https://github.com/jackra1n/Lurk/commit/62d73da10155090c8a47c0de91502d3044c508ea))
* show latest balance and improve layout ([ef89886](https://github.com/jackra1n/Lurk/commit/ef898860653f85e16043bea94dc3c2d1abd4c3c7))
* standardize date and number formatting ([a94badc](https://github.com/jackra1n/Lurk/commit/a94badca81351029a7b89758db788c2fedd4b3ff))
* **theme:** add dark/light theme toggle ([98415ff](https://github.com/jackra1n/Lurk/commit/98415ffeb486a0bd11b856050833b354c48cf768))
* track stream start/end and initial points ([cbaec25](https://github.com/jackra1n/Lurk/commit/cbaec2505378050bb2a72c492864b2eb06985adb))
* **ui:** improve dashboard message alerts ([ecf440e](https://github.com/jackra1n/Lurk/commit/ecf440e829602c2f2e539b21f3c126bda12997f2))


### Bug Fixes

* add more checks ([ead578b](https://github.com/jackra1n/Lurk/commit/ead578bca06a64ed224a14a14b11720b8663327c))
* correct dashboard sort directions and apply stable tiebreakers ([e7d449d](https://github.com/jackra1n/Lurk/commit/e7d449d6e8d2926e38c5693a6880de63bc4db592))
* make async ([7c81397](https://github.com/jackra1n/Lurk/commit/7c81397d86a25b4ef273935d1896a3d814880f14))
* make streamer analytics independent of chart time range ([643cdef](https://github.com/jackra1n/Lurk/commit/643cdef4831f85caeecd520874cf08e6258d946c))
* remove flickering when changing sort/streamer for the chart ([3726769](https://github.com/jackra1n/Lurk/commit/37267699437d9bc7dce6a347e40f35d1ba29ce36))
* streamer sorting logic ([fefb178](https://github.com/jackra1n/Lurk/commit/fefb178b7f1d5d8e1de25a478814eaf633f4b33c))


### Dependencies

* remove direct LibSQL client dev dependency ([5703e8b](https://github.com/jackra1n/Lurk/commit/5703e8b87f134d8bfc97f3d2ff0e0d286338b560))


### Documentation

* add GNU AGPL v3 license ([50a486d](https://github.com/jackra1n/Lurk/commit/50a486dc4ceb0ca64e7c573ebd396a590f0cf7a6))
* add project preview and simplify readme ([055d8a3](https://github.com/jackra1n/Lurk/commit/055d8a3ee6d815e933ee845a219ed15331552400))
* **db-schema:** add database schema overview ([ac73b0f](https://github.com/jackra1n/Lurk/commit/ac73b0f8130307bf8d318bc0ff5fa1dc9837f27b))
* restructure and expand README ([3e78afb](https://github.com/jackra1n/Lurk/commit/3e78afba1d28d47fb4bd8b419bad83c0cbd25cc2))
* update readme ([c1d0071](https://github.com/jackra1n/Lurk/commit/c1d0071e7edbb991b68d36ff147079dc09c3143d))
* update README.md ([4d7eb84](https://github.com/jackra1n/Lurk/commit/4d7eb84d0dee6aef985b58605c8d1550b935198d))


### Styles

* adjust miner status card layout ([55e160a](https://github.com/jackra1n/Lurk/commit/55e160af801e5e7f7f3d067549772e7e8a4c23a1))
* center footer content ([fefe5e1](https://github.com/jackra1n/Lurk/commit/fefe5e146ef5ece56a4dc3857419bcabbb291dab))
* update chart color variables ([bcdd4c3](https://github.com/jackra1n/Lurk/commit/bcdd4c35f8457f6221c3b4e48835a05d8b3f4c15))
* update primary and related colors ([1a124b4](https://github.com/jackra1n/Lurk/commit/1a124b447ccc3b48b8fde481c3fea217e7df4542))


### Refactoring

* adjust classes ([d8ffa09](https://github.com/jackra1n/Lurk/commit/d8ffa09796a810e901c2d5031dd4bd44fa0f89eb))
* adjust default analytics sort ([7fc9b77](https://github.com/jackra1n/Lurk/commit/7fc9b779e6f35bb13a4ca4185a758a2a7d74f86a))
* centralize dashboard sorting logic ([b602575](https://github.com/jackra1n/Lurk/commit/b602575b71fa10428a42ed9221a68d4becf4ac6f))
* change page title ([a957fbc](https://github.com/jackra1n/Lurk/commit/a957fbcb7ea1d1088d3112a3e608248c38949752))
* cleanp component a bit ([84abeba](https://github.com/jackra1n/Lurk/commit/84abeba497d93a7d727bde6019e658d328c80f97))
* cleanup dead code ([613442f](https://github.com/jackra1n/Lurk/commit/613442f3f800f19af9a8c4ec2d8780c4ec6aae5a))
* cleanup streamer time properties ([4ff8ee3](https://github.com/jackra1n/Lurk/commit/4ff8ee3c7fcafa1b54eb5afea475f06557ca2b1e))
* **dashboard:** organize components into subdirectories ([543becf](https://github.com/jackra1n/Lurk/commit/543becf5369fdc308bde772117b0ed27135ca17d))
* improve token and session handling ([e50770b](https://github.com/jackra1n/Lurk/commit/e50770bc6cf8e45223906c1c9c731965d0f6a811))
* **logger:** separate console and file log formatting ([8ecedc2](https://github.com/jackra1n/Lurk/commit/8ecedc232ba544a376b726e13107dd2af4d8a8aa))
* modularize miner service ([0e719db](https://github.com/jackra1n/Lurk/commit/0e719db45f57453adf2fe8ca5234b16c1eff2bd9))
* move dashboard notices to component ([eb384ea](https://github.com/jackra1n/Lurk/commit/eb384eab1cd844aa6bee4d70e3b19d7109ccf0f6))
* move miner quick actions to status card ([039e799](https://github.com/jackra1n/Lurk/commit/039e799dbf371c096da368cdcc02552307220e49))
* move miner quick actions to status card ([b84c75b](https://github.com/jackra1n/Lurk/commit/b84c75bb0ab9ff01c50bcbc2c18b13e79ccf8cef))
* remove logout option from auth status ([cf24829](https://github.com/jackra1n/Lurk/commit/cf24829e29653027870ccd119f61c15c5bef76c6))
* remove unused cookie stuff ([8579bde](https://github.com/jackra1n/Lurk/commit/8579bde5024a292000460629a86dbd08d42e2132))
* replace magic strings with enums ([872de84](https://github.com/jackra1n/Lurk/commit/872de8498f461cf26f2751078d97dd1596aa3056))
* sorting dashboard ([ad790c4](https://github.com/jackra1n/Lurk/commit/ad790c4eea7da2175c9bf7f91bb73d757bd000dc))
* split calendar range into separate component + fix ([7daee30](https://github.com/jackra1n/Lurk/commit/7daee30fe5229e5b018435e3370634a6496bc59a))
* split PointsOverview into chart and list ([135b733](https://github.com/jackra1n/Lurk/commit/135b7338dc4d9aedb19237e751488faeb8639ef7))
* split some properties from StreamState into StreamData ([4f68167](https://github.com/jackra1n/Lurk/commit/4f6816714b5de02e653477e1d1474c74a7f92d1d))
* **ui:** standardizes tooltip usage ([91ab030](https://github.com/jackra1n/Lurk/commit/91ab03026123a0576fd596725d42122cc8542c2f))
* update logging levels ([cc2e843](https://github.com/jackra1n/Lurk/commit/cc2e843fef97cb8a6abbf963b4bf83ac4e30cd70))
* use 'node:' prefix for crypto import ([e4b6bc0](https://github.com/jackra1n/Lurk/commit/e4b6bc0c323baaf11338b7580373d3bd0827e8d0))


### Tests

* add dashboard analytics sorting tests ([7b8a406](https://github.com/jackra1n/Lurk/commit/7b8a406a279cb0367b558b83363b91caf3457968))


### CI/CD

* adjust push trigger and concurrency ([dd2eadc](https://github.com/jackra1n/Lurk/commit/dd2eadc527f3962007e0a1112390013f7bd4500c))
* run unit tests ([ec0bed4](https://github.com/jackra1n/Lurk/commit/ec0bed40181041bdd2f06861cdce76958dfcade0))


### Miscellaneous

* initial release ([1b12186](https://github.com/jackra1n/Lurk/commit/1b1218626f3c5152e1b33c0f2ce833b371aeb8e9))
