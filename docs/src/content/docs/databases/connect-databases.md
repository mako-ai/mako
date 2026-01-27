---
title: Connect Databases
description: Learn how to connect your external databases to Mako.
---

## IP Whitelisting

If your database requires IP whitelisting, add the following IP address to your allowlist:

```
34.79.190.46
```

This is the static outbound IP used by Mako's cloud service for all database connections.

## MongoDB Atlas

In MongoDB Atlas, when you click "connect" to your data source in your account, the website gives you a string that looks like this:

`mongodb+srv://<db_username>:<db_password>@<cluster_name>.<server_name>.mongodb.net/?appName=<cluster_name>`

In Mako, you actually need to paste this URL:

`mongodb+srv://<db_username>:<db_password>@<cluster_name>.<server_name>.mongodb.net/<cluster_name>`

(notice the query param vs the segment)

### IP Whitelisting in Atlas

1. Go to **Network Access** in your MongoDB Atlas project
2. Click **Add IP Address**
3. Enter `34.79.190.46`
4. Click **Confirm**
