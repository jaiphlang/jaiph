# Reproduce e2e on Ubuntu (e.g. GitHub Actions runner).
# Usage: docker build -t jaiph-e2e -f e2e/Dockerfile . && docker run --rm jaiph-e2e
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Run full e2e suite (or override: docker run --rm jaiph-e2e bash e2e/tests/95_say_hello_failure_output.sh)
CMD ["bash", "./e2e/test_all.sh"]
