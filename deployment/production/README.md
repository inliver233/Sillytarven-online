# Production configuration snapshot

These files mirror the non-secret OpenResty and logrotate settings used by
`st.pixcora.com`. They are recovery references; they are not loaded directly
from this directory.

Production paths:

- `openresty/st.pixcora.com.conf` -> `/root/1panel/1panel/www/conf.d/st.pixcora.com.conf`
- `openresty/root.conf` -> `/root/1panel/1panel/www/sites/st.pixcora.com/proxy/root.conf`
- `logrotate/st-pixcora` -> `/etc/logrotate.d/st-pixcora`
- `logrotate/sillytavern-pm2` -> `/etc/logrotate.d/sillytavern-pm2`
- `logrotate/sillytavern-app-access` -> `/etc/logrotate.d/sillytavern-app-access`

Validate OpenResty with `openresty -t` inside the 1Panel OpenResty container
before reloading it. Validate each rotation policy with `logrotate -d FILE`.
The secret-bearing production `config.yaml` is intentionally excluded.
