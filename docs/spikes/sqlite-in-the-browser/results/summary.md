# Raw results, arranged

Generated 2026-08-22T19:46:20.351Z by `run/summarise.ts` from `results/browser-*.json`.

## Write, read and cold start by workload size

`us/mutation` is the write cost divided by mutations, so batch size is normalised out. `us/read` is a point lookup by `(entity, id)` at the tip; for the SQLite candidates it is measured INSIDE the worker, so it excludes the page-to-worker round-trip a real caller would also pay.

### chromium

| backend | size | live rows | mut/block | ms/block | us/mutation | us/read | us/as-of | open ms | reopen ms | survived reload |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- |
| memory | real | 4072 | 37 | 0.045 | 1 | 4 | 6 | 0.1 | 0.0 | false |
| idb-versioned | real | 4072 | 37 | 45.611 | 1244 | 305 | 577 | 26.0 | 164.7 | true |
| idb-versioned-cached | real | 4072 | 37 | 42.522 | 1160 | 32 | 481 | 48.9 | 52.0 | true |
| blob-structured-clone | real | 4072 | 37 | 1.964 | 54 | 2 | refused | 0.0 | 0.0 | true |
| blob-json | real | 4072 | 37 | 2.047 | 56 | 1 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | real | 4072 | 37 | 81.875 | 2234 | 1185 | 1536 | 182.9 | 117.7 | true |
| sqlite-opfs-sahpool | real | 4072 | 37 | 74.171 | 2024 | 1246 | 2314 | 144.2 | 430.7 | true |
| memory | tiny | 245 | 37 | 0.025 | 1 | 2 | 1 | 0.0 | 0.0 | false |
| idb-versioned | tiny | 245 | 37 | 7.192 | 193 | 122 | 159 | 7.1 | 0.7 | true |
| blob-structured-clone | tiny | 245 | 37 | 0.608 | 16 | 3 | refused | 0.0 | 0.0 | true |
| blob-json | tiny | 245 | 37 | 0.783 | 21 | 2 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | tiny | 245 | 37 | 97.304 | 2612 | 1011 | 861 | 172.7 | 106.6 | true |
| sqlite-opfs-sahpool | tiny | 245 | 37 | 62.083 | 1667 | 423 | 361 | 148.4 | 87.9 | true |
| memory | small | 1258 | 86 | 0.058 | 1 | 2 | 3 | 0.0 | 0.0 | false |
| idb-versioned | small | 1258 | 86 | 24.082 | 282 | 154 | 181 | 1.2 | 0.7 | true |
| blob-structured-clone | small | 1258 | 86 | 0.921 | 11 | 2 | refused | 0.0 | 0.0 | true |
| blob-json | small | 1258 | 86 | 0.889 | 10 | 2 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | small | 1258 | 86 | 130.288 | 1524 | 899 | 837 | 166.7 | 114.9 | true |
| sqlite-opfs-sahpool | small | 1258 | 86 | 66.476 | 777 | 370 | 332 | 132.5 | 81.5 | true |
| memory | medium | 7406 | 177 | 0.124 | 1 | 1 | 2 | 0.0 | 0.0 | false |
| idb-versioned | medium | 7406 | 177 | 90.712 | 513 | 239 | 247 | 10.5 | 1.0 | true |
| blob-structured-clone | medium | 7406 | 177 | 3.938 | 22 | 1 | refused | 0.1 | 0.0 | true |
| blob-json | medium | 7406 | 177 | 5.272 | 30 | 2 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | medium | 7406 | 177 | 143.886 | 814 | 999 | 881 | 140.3 | 97.8 | true |
| sqlite-opfs-sahpool | medium | 7406 | 177 | 99.599 | 563 | 437 | 446 | 129.9 | 95.5 | true |
| memory | large | 44459 | 325 | 0.295 | 1 | 2 | 2 | 0.0 | 0.0 | false |
| idb-versioned | large | 44459 | 325 | 421.651 | 1299 | 268 | 345 | 12.7 | 0.6 | true |
| blob-structured-clone | large | 44459 | 325 | 20.246 | 62 | 2 | refused | 0.1 | 0.0 | true |
| blob-json | large | 44459 | 325 | 24.449 | 75 | 3 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | large | 44459 | 325 | 286.193 | 882 | 1118 | 939 | 168.4 | 97.6 | true |
| sqlite-opfs-sahpool | large | 44459 | 325 | 188.434 | 581 | 378 | 339 | 123.0 | 85.2 | true |
| memory | sweep | 20775 | 132 | 0.098 | 1 | 2 | 2 | 0.0 | 0.0 | false |
| idb-versioned | sweep | 20775 | 132 | 107.789 | 814 | 201 | 244 | 3.9 | 0.8 | true |
| idb-versioned-cached | sweep | 20775 | 132 | 165.031 | 1246 | 3 | 289 | 15.2 | 244.2 | true |
| blob-structured-clone | sweep | 20775 | 132 | 8.483 | 64 | 2 | refused | 0.0 | 0.0 | true |
| blob-json | sweep | 20775 | 132 | 9.82 | 74 | 2 | refused | 0.1 | 0.0 | true |
| sqlite-opfs | sweep | 20775 | 132 | 165.714 | 1251 | 986 | 832 | 144.3 | 104.7 | true |
| sqlite-opfs-sahpool | sweep | 20775 | 132 | 115.138 | 870 | 354 | 343 | 134.7 | 75.0 | true |

### firefox

| backend | size | live rows | mut/block | ms/block | us/mutation | us/read | us/as-of | open ms | reopen ms | survived reload |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- |
| memory | real | 4072 | 37 | 0.148 | 4 | 30 | 5 | 0.0 | 0.0 | false |
| idb-versioned | real | 4072 | 37 | 10.045 | 274 | 155 | 190 | 15.0 | 12.0 | true |
| idb-versioned-cached | real | 4072 | 37 | 3.856 | 105 | 5 | 215 | 11.0 | 125.0 | true |
| blob-structured-clone | real | 4072 | 37 | 5.392 | 147 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | real | 4072 | 37 | 10.546 | 288 | 25 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | real | 4072 | 37 | 208.131 | 5678 | 2239 | 2539 | 188.0 | 546.1 | true |
| sqlite-opfs-sahpool | real | 4072 | 37 | 30.117 | 822 | 490 | 510 | 390.0 | 1086.0 | true |
| memory | tiny | 245 | 37 | 0 | 0 | 5 | 5 | 0.0 | 0.0 | false |
| idb-versioned | tiny | 245 | 37 | 7 | 188 | 120 | 135 | 4.0 | 2.0 | true |
| idb-versioned-cached | tiny | 245 | 37 | 2.917 | 78 | 10 | 125 | 4.0 | 6.0 | true |
| blob-structured-clone | tiny | 245 | 37 | 0.75 | 20 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | tiny | 245 | 37 | 0.833 | 22 | 5 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | tiny | 245 | 37 | 171.495 | 4604 | 1758 | 1728 | 213.8 | 138.9 | true |
| sqlite-opfs-sahpool | tiny | 245 | 37 | 24.917 | 669 | 340 | 325 | 130.0 | 92.0 | true |
| memory | small | 1258 | 86 | 0.105 | 1 | 5 | 5 | 0.0 | 0.0 | false |
| idb-versioned | small | 1258 | 86 | 14.395 | 168 | 125 | 190 | 4.0 | 1.0 | true |
| idb-versioned-cached | small | 1258 | 86 | 6.895 | 81 | 10 | 125 | 3.0 | 13.0 | true |
| blob-structured-clone | small | 1258 | 86 | 1.184 | 14 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | small | 1258 | 86 | 1.079 | 13 | 10 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | small | 1258 | 86 | 192.873 | 2256 | 1853 | 1715 | 159.1 | 124.0 | true |
| sqlite-opfs-sahpool | small | 1258 | 86 | 35.684 | 417 | 330 | 345 | 130.0 | 111.0 | true |
| memory | medium | 7406 | 177 | 0.302 | 2 | 15 | 30 | 0.0 | 0.0 | false |
| idb-versioned | medium | 7406 | 177 | 40.371 | 228 | 140 | 130 | 3.0 | 1.0 | true |
| idb-versioned-cached | medium | 7406 | 177 | 14.345 | 81 | 5 | 140 | 4.0 | 130.0 | true |
| blob-structured-clone | medium | 7406 | 177 | 7.103 | 40 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | medium | 7406 | 177 | 5.25 | 30 | 10 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | medium | 7406 | 177 | 289.887 | 1640 | 1744 | 1761 | 255.1 | 123.4 | true |
| sqlite-opfs-sahpool | medium | 7406 | 177 | 63.871 | 361 | 325 | 325 | 139.0 | 97.0 | true |
| memory | sweep | 20775 | 132 | 0.899 | 7 | 5 | 5 | 0.0 | 0.0 | false |
| idb-versioned | sweep | 20775 | 132 | 36.235 | 274 | 215 | 300 | 20.0 | 11.0 | true |
| idb-versioned-cached | sweep | 20775 | 132 | 13.153 | 99 | 35 | 220 | 28.0 | 745.0 | true |
| blob-structured-clone | sweep | 20775 | 132 | 21.912 | 165 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | sweep | 20775 | 132 | 18.044 | 136 | 10 | refused | 0.0 | 0.0 | true |
| sqlite-opfs | sweep | 20775 | 132 | 351.038 | 2651 | 1725 | 1789 | 201.0 | 155.1 | true |
| sqlite-opfs-sahpool | sweep | 20775 | 132 | 59.422 | 449 | 335 | 320 | 160.0 | 229.0 | true |

### webkit

| backend | size | live rows | mut/block | ms/block | us/mutation | us/read | us/as-of | open ms | reopen ms | survived reload |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --: | --- |
| memory | real | 4072 | 37 | 0.065 | 2 | 5 | 5 | 0.0 | 0.0 | false |
| idb-versioned | real | 4072 | 37 | 11.688 | 319 | 205 | 315 | 49.0 | 47.0 | true |
| idb-versioned-cached | real | 4072 | 37 | 12.99 | 354 | 555 | 4695 | 42.0 | 302.0 | true |
| blob-structured-clone | real | 4072 | 37 | 4.548 | 124 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | real | 4072 | 37 | 5.379 | 147 | 25 | refused | 1.0 | 0.0 | true |
| sqlite-opfs (fell back to memory) | real | 4072 | 37 | 2.213 | 60 | 144 | 143 | 269.3 | 210.6 | false |
| sqlite-opfs-sahpool | real | | | | | | | | | UNAVAILABLE: Error: Error: Missing required OPFS APIs. |
| memory | tiny | 245 | 37 | 0 | 0 | 0 | 5 | 0.0 | 0.0 | false |
| idb-versioned | tiny | 245 | 37 | 6.5 | 174 | 155 | 230 | 14.0 | 0.0 | true |
| idb-versioned-cached | tiny | 245 | 37 | 3.583 | 96 | 0 | 215 | 3.0 | 4.0 | true |
| blob-structured-clone | tiny | 245 | 37 | 0.75 | 20 | 0 | refused | 0.0 | 0.0 | true |
| blob-json | tiny | 245 | 37 | 1 | 27 | 0 | refused | 0.0 | 0.0 | true |
| sqlite-opfs (fell back to memory) | tiny | 245 | 37 | 7.122 | 191 | 124 | 83 | 125.8 | 97.3 | false |
| sqlite-opfs-sahpool | tiny | | | | | | | | | UNAVAILABLE: Error: Error: Missing required OPFS APIs. |
| memory | small | 1258 | 86 | 0.079 | 1 | 0 | refused | 0.0 | 0.0 | false |
| idb-versioned | small | 1258 | 86 | 16.921 | 198 | 160 | 205 | 4.0 | 0.0 | true |
| idb-versioned-cached | small | 1258 | 86 | 8.447 | 99 | 0 | 185 | 4.0 | 11.0 | true |
| blob-structured-clone | small | 1258 | 86 | 1.105 | 13 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | small | 1258 | 86 | 1.184 | 14 | 0 | refused | 0.0 | 0.0 | true |
| sqlite-opfs (fell back to memory) | small | 1258 | 86 | 8.158 | 95 | 105 | 71 | 104.5 | 95.0 | false |
| sqlite-opfs-sahpool | small | | | | | | | | | UNAVAILABLE: @http://127.0.0.1:39387/bundle.js:442:42 |
| memory | medium | 7406 | 177 | 0.147 | 1 | 5 | 5 | 0.0 | 0.0 | false |
| idb-versioned | medium | 7406 | 177 | 37.095 | 210 | 175 | 190 | 9.0 | 7.0 | true |
| idb-versioned-cached | medium | 7406 | 177 | 18.922 | 107 | 5 | 195 | 8.0 | 58.0 | true |
| blob-structured-clone | medium | 7406 | 177 | 4.94 | 28 | 5 | refused | 0.0 | 0.0 | true |
| blob-json | medium | 7406 | 177 | 5.181 | 29 | 5 | refused | 0.0 | 0.0 | true |
| sqlite-opfs (fell back to memory) | medium | 7406 | 177 | 8.915 | 50 | 87 | 56 | 99.3 | 94.1 | false |
| sqlite-opfs-sahpool | medium | | | | | | | | | UNAVAILABLE: @http://127.0.0.1:33801/bundle.js:442:42 |
| memory | sweep | 20775 | 132 | 0.254 | 2 | 0 | refused | 0.0 | 0.0 | false |
| idb-versioned | sweep | 20775 | 132 | 28.723 | 217 | 160 | 215 | 11.0 | 8.0 | true |
| idb-versioned-cached | sweep | 20775 | 132 | 14.754 | 111 | 5 | 205 | 17.0 | 192.0 | true |
| blob-structured-clone | sweep | 20775 | 132 | 14.124 | 107 | 0 | refused | 0.0 | 0.0 | true |
| blob-json | sweep | 20775 | 132 | 13.821 | 104 | 5 | refused | 0.0 | 0.0 | true |
| sqlite-opfs (fell back to memory) | sweep | 20775 | 132 | 5.552 | 42 | 87 | 75 | 117.0 | 147.5 | false |
| sqlite-opfs-sahpool | sweep | | | | | | | | | UNAVAILABLE: Error: Error: Missing required OPFS APIs. |

## The crossover: cost per mutation as the store grows

One run of the `sweep` workload, which holds the batch roughly constant (100 to 128 mutations per block) and lets only the dataset grow, to 20,775 live rows over 476 blocks. Each column is a tenth of the run; the header is how many mutations had already been written when it started.

### chromium (microseconds per mutation)

| backend | 0 | 5680 | 12171 | 18662 | 25065 | 31428 | 37799 | 44353 | 50870 | 57270 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| memory | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| idb-versioned | 180 | 199 | 206 | 321 | 518 | 866 | 1088 | 1304 | 1666 | 1822 |
| blob-structured-clone | 11 | 26 | 32 | 43 | 58 | 73 | 84 | 88 | 106 | 119 |
| blob-json | 12 | 23 | 35 | 52 | 69 | 87 | 97 | 113 | 120 | 134 |
| sqlite-opfs | 798 | 924 | 1029 | 1196 | 1257 | 1349 | 1374 | 1478 | 1528 | 1561 |
| sqlite-opfs-sahpool | 593 | 648 | 726 | 840 | 867 | 943 | 976 | 1000 | 1031 | 1059 |
| idb-versioned-cached | 161 | 388 | 631 | 889 | 1143 | 1432 | 1646 | 1753 | 2220 | 2174 |

### firefox (microseconds per mutation)

| backend | 0 | 5680 | 12171 | 18662 | 25065 | 31428 | 37799 | 44353 | 50870 | 57270 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| memory | 6 | 7 | 6 | 6 | 8 | 6 | 7 | 7 | 7 | 7 |
| idb-versioned | 217 | 234 | 230 | 235 | 245 | 247 | 251 | 438 | 392 | 236 |
| idb-versioned-cached | 84 | 93 | 98 | 101 | 95 | 99 | 101 | 105 | 103 | 114 |
| blob-structured-clone | 29 | 57 | 94 | 129 | 150 | 178 | 200 | 234 | 264 | 320 |
| blob-json | 21 | 33 | 70 | 92 | 115 | 128 | 148 | 210 | 248 | 300 |
| sqlite-opfs | 1702 | 1999 | 2208 | 2528 | 2646 | 2889 | 2919 | 3091 | 3205 | 3282 |
| sqlite-opfs-sahpool | 363 | 379 | 407 | 439 | 446 | 465 | 474 | 496 | 502 | 513 |

### webkit (microseconds per mutation)

| backend | 0 | 5680 | 12171 | 18662 | 25065 | 31428 | 37799 | 44353 | 50870 | 57270 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| memory | 2 | 2 | 2 | 2 | 3 | 2 | 2 | 2 | 2 | 2 |
| idb-versioned | 206 | 209 | 218 | 222 | 224 | 215 | 220 | 224 | 215 | 215 |
| idb-versioned-cached | 89 | 105 | 109 | 108 | 112 | 114 | 114 | 125 | 118 | 119 |
| blob-structured-clone | 18 | 34 | 48 | 74 | 96 | 109 | 131 | 153 | 189 | 217 |
| blob-json | 18 | 35 | 54 | 78 | 95 | 113 | 128 | 148 | 173 | 202 |
| sqlite-opfs | 74 | 38 | 39 | 40 | 40 | 39 | 36 | 41 | 38 | 39 |

## Footprint by retention window

- **chromium / idb-versioned / sweep**: `{"unboundedCounts":{"current":20775,"versions":62553,"blocks":476},"unboundedEstimate":14201039,"window-1000":{"dropped":0,"pruneMs":854.8,"counts":{"current":20775,"versions":62553,"blocks":476},"estimate":24093218},"window-64":{"dropped":19104,"pruneMs":6303.4,"counts":{"current":20775,"versions":43449,"blocks":476},"estimate":13027642}}`
- **chromium / sqlite-opfs-sahpool / sweep**: `{"unbounded":7053312,"window-1000":6504448,"window-1000-pruneMs":914.5,"window-64":3817472,"window-64-pruneMs":1097.3}`
- **chromium / idb-versioned / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"unboundedEstimate":7694351,"window-1000":{"dropped":25299,"pruneMs":14713,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":7553501},"window-64":{"dropped":0,"pruneMs":217,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":7553501}}`
- **chromium / idb-versioned-cached / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"unboundedEstimate":13943722,"window-1000":{"dropped":25299,"pruneMs":8898.5,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":7157627},"window-64":{"dropped":0,"pruneMs":203.1,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":7157627}}`
- **chromium / sqlite-opfs / real**: `{"unbounded":4947968,"window-1000":1212416,"window-1000-pruneMs":1188.2,"window-64":1212416,"window-64-pruneMs":288.3}`
- **chromium / sqlite-opfs-sahpool / real**: `{"unbounded":4947968,"window-1000":1212416,"window-1000-pruneMs":2296.1,"window-64":1212416,"window-64-pruneMs":617}`
- **firefox / idb-versioned / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"unboundedEstimate":31603936,"window-1000":{"dropped":25299,"pruneMs":9218,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":38060160},"window-64":{"dropped":0,"pruneMs":119,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":38060160}}`
- **firefox / idb-versioned-cached / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"unboundedEstimate":31603936,"window-1000":{"dropped":25299,"pruneMs":7807,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":38060160},"window-64":{"dropped":0,"pruneMs":152,"counts":{"current":4072,"versions":12893,"blocks":1042},"estimate":38060160}}`
- **firefox / sqlite-opfs / real**: `{"unbounded":4947968,"window-1000":1212416,"window-1000-pruneMs":3314.9,"window-64":1212416,"window-64-pruneMs":660.2}`
- **firefox / sqlite-opfs-sahpool / real**: `{"unbounded":4947968,"window-1000":1212416,"window-1000-pruneMs":652,"window-64":1212416,"window-64-pruneMs":104}`
- **webkit / idb-versioned / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"window-1000":{"dropped":25299,"pruneMs":7597,"counts":{"current":4072,"versions":12893,"blocks":1042}},"window-64":{"dropped":0,"pruneMs":679,"counts":{"current":4072,"versions":12893,"blocks":1042}}}`
- **webkit / idb-versioned-cached / real**: `{"unboundedCounts":{"current":4072,"versions":38192,"blocks":1042},"window-1000":{"dropped":25299,"pruneMs":7806,"counts":{"current":4072,"versions":12893,"blocks":1042}},"window-64":{"dropped":0,"pruneMs":464,"counts":{"current":4072,"versions":12893,"blocks":1042}}}`
- **webkit / sqlite-opfs / real**: `{"unbounded":4947968,"window-1000":1212416,"window-1000-pruneMs":55.9,"window-64":1212416,"window-64-pruneMs":8.1}`

## Multi-tab: four tabs, one origin, one database

| engine | backend | tabs that failed | first failure |
| --- | --- | --: | --- |
| chromium | idb-versioned | 0/4 | none |
| chromium | sqlite-opfs-sahpool | 3/4 | Error: Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there i |
| chromium | sqlite-opfs | 3/4 | Error: SQLITE_BUSY: sqlite3 result code 5: database is locked
    at SqliteWorkerStore.worker.onmessage (http://127.0.0. |
| firefox | idb-versioned | 0/4 | none |
| firefox | sqlite-opfs-sahpool | 3/4 | SqliteWorkerStore/this.worker.onmessage@http://127.0.0.1:36225/bundle.js:442:33
EventHandlerNonNull*SqliteWorkerStore@ht |
| firefox | sqlite-opfs | 3/4 | SqliteWorkerStore/this.worker.onmessage@http://127.0.0.1:46503/bundle.js:442:33
EventHandlerNonNull*SqliteWorkerStore@ht |
| webkit | idb-versioned | 0/4 | none |
| webkit | sqlite-opfs-sahpool | 4/4 | @http://127.0.0.1:37329/bundle.js:442:42 |
| webkit | sqlite-opfs | 0/4 | none |

## Mid-range device profile (Chromium, 4x CPU throttle)

| backend | ms/block laptop | ms/block throttled | us/read laptop | us/read throttled |
| --- | --: | --: | --: | --: |
| idb-versioned | 90.712 | 113.067 | 239 | 666 |
| blob-structured-clone | 3.938 | 15.483 | 1 | 6 |
| sqlite-opfs-sahpool | 99.599 | 107.336 | 437 | 421 |

## The light path: backwards replay over immer reverse patches

| engine | state | patch log (64 blocks) | depth 1 | depth 8 | depth 32 | depth 64 | all correct |
| --- | --: | --: | --: | --: | --: | --: | --- |
| chromium | 763 KB | 1702 KB | 3.4 ms | 16.7 ms | 75.2 ms | 126.4 ms | true |
| firefox | 763 KB | 1702 KB | 6 ms | 15 ms | 64 ms | 103 ms | true |
| webkit | 763 KB | 1702 KB | 10 ms | 36 ms | 101 ms | 214 ms | true |
