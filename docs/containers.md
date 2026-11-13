# Containers

Bahasa Indonesia: [id/containers.md](id/containers.md)

DevOps › Containers shows the Docker containers on the machine a self-hosted Watchbell runs on: their state, health,
ports and image, and for one container its last 200 log lines, one CPU and memory reading, and how often it restarted.
The owner can start, stop and restart a container. It's part of the self-hosted edition only.

## Turn it on

Access to the Docker socket is root-equivalent on the machine, so Containers is off until you turn it on.

1. Add `WATCHBELL_DOCKER=on` to `app/.env` (see [Configuration](configuration.md#optional-settings)).
2. Give the user that runs Watchbell access to the Docker socket. On Linux, add it to the `docker` group
   (`sudo usermod -aG docker <user>`), then sign out and in again; when Watchbell runs as a systemd service,
   restarting the service is enough. On Windows, Docker Desktop's named pipe is used.
3. Restart Watchbell.

Watchbell talks to Docker over the local socket only (`/var/run/docker.sock`, or `//./pipe/docker_engine` on Windows).
Set `DOCKER_HOST` to a `unix://` or `npipe://` address if yours is somewhere else; a `tcp://` address is refused.

## What it reads, and when

The list is read when you open the page or press **Refresh**, and a container's details when you open them. Nothing
runs on a schedule and Containers raises no alerts. Log lines that look like secrets (tokens, passwords, keys) are
masked before they're shown. Operators and owners can open the page; viewers can't.

## What it can change

Only the owner, and only these three:

- **Start** a stopped container.
- **Restart** or **Stop** a running one. Both ask you to type the container's name first.

Every action is written to Events. Watchbell never removes a container, runs or execs into one, pulls or builds
images, or touches volumes and networks. It won't stop or restart the container it runs in, when it runs in one.
