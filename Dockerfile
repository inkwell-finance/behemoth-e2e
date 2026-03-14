# E2E Test Runner for Behemoth Cross-Repo Tests
FROM oven/bun:1.1

WORKDIR /app

# Copy E2E test package
COPY e2e/package.json e2e/bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Copy test files
COPY e2e/tests ./tests
COPY e2e/tsconfig.json ./

# Run tests
CMD ["bun", "test", "--timeout", "120000"]

