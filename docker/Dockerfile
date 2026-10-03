# Postgres 17 with the two extensions qopt needs beyond contrib:
#   hypopg   - hypothetical indexes (validation without building anything)
#   pgvector - embeddings for documentation retrieval (meta database)
FROM postgres:17
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17-hypopg postgresql-17-pgvector \
 && rm -rf /var/lib/apt/lists/*
