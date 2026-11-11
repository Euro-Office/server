# Server

[![License](https://img.shields.io/badge/License-GNU%20AGPL%20V3-green.svg?style=flat)](https://www.gnu.org/licenses/agpl-3.0.en.html)

The backend server software layer which is a part of [Euro-Office Document Server](https://github.com/Euro-Office/DocumentServer) and is the base for all other components.

## File converter worker count

Set `FileConverter.converter.workercount` to a positive integer in your administrator
configuration (`local.json`) to choose the number of file-conversion workers directly:

```json
{
  "FileConverter": {
    "converter": {
      "workercount": 2
    }
  }
}
```

For file-based installations, use the `local.json` next to the deployed
`default.json` (typically `/etc/euro-office/documentserver/local.json` on Linux).
Keep administrator overrides in `local.json`; upgrades replace `default.json`.

The explicit count takes precedence over CPU availability and
`FileConverter.converter.maxprocesscount`. It is not capped by the number of CPUs;
choose a count appropriate for the server's memory and workload.

The default is `null`. When the setting is absent or `null`, the existing automatic
calculation is unchanged: the available parallelism (or CPU count if unavailable)
multiplied by `maxprocesscount`, rounded up. Invalid values, including zero,
negative numbers, fractions, numeric strings and integers outside JavaScript's
safe range, log a warning and fall back to that same calculation.

In particular, `workercount: 0` does not itself disable conversion: it selects
automatic sizing, which may start more workers than intended.

Restart the converter service after changing this setting. Existing installations
that only set `maxprocesscount` keep their current behavior.

## License

Server is released under an GNU AGPL v3.0 license. See the LICENSE file for more information.
