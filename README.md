# hexo-deployer-upyun

UPYUN (又拍云) deployer plugin for Hexo. Supports concurrent upload, automatic retry, and incremental deployment.

## Install

```bash
npm install hexo-deployer-upyun --save
```

## Configuration

In your Hexo `_config.yml`:

```yaml
deploy:
  type: upyun
  bucket: your-bucket-name
  operator:           # UPYUN operator name, or set UPYUN_OPERATOR env var
  password:           # UPYUN operator password, or set UPYUN_PASSWORD env var
  concurrency: 10     # Concurrent upload limit (default: 10)
  try_times: 3        # Retry attempts per file (default: 3)
  force: false        # Force full upload, skip incremental diff (default: false)
  ignore_path_re:
    dir: null          # Regex to ignore directories
    file: ".DS_Store$" # Regex to ignore files
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `UPYUN_OPERATOR` | Operator name (overrides config) |
| `UPYUN_PASSWORD` | Operator password (overrides config) |
| `UPYUN_FORCE` | Set to `1` to force full upload |

## Features

- **Incremental deploy**: Only uploads changed files (based on MD5 comparison)
- **Concurrent upload**: Configurable parallelism for fast deployment
- **Auto retry**: Failed operations are retried with exponential backoff
- **Fault tolerant**: Single file failures don't abort the entire deployment
- **Force mode**: Skip diff calculation for a guaranteed full sync

## License

GPL-3.0

## Image upload responses

Version 1.0.1 accepts the UPYUN SDK image-metadata response as a successful upload, as well as the `true` response used for other files. This avoids retrying successfully uploaded PNG/JPEG files and prevents a stale incremental deployment manifest.
