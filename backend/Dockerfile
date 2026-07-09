# syntax=docker/dockerfile:1

# =============================================================================
# Hydropark backend image.
#
# One image, three trust zones (BACKEND-DESIGN.md §2, §6.2; AGENT-CONTRACT.md
# "Trust zones"). Which zone(s) a *container* plays is decided entirely by env
# vars at `docker run` time - HP_API_ENABLED / HP_ISSUER_ENABLED /
# HP_WORKER_ENABLED - see deploy/docker-compose.yml and deploy/fly/*.toml.
# This Dockerfile does not know or care which zone it will become; it never
# bakes a secret in, and nothing here should change per-zone.
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: compile with Maven's own image (no wrapper needed, per environment
# notes - Maven 3.9 is standard here). `pom.xml` is copied and resolved in its
# own layer, keyed separately from `src/`, so an ordinary source-only change
# does not force Docker to re-resolve every dependency.
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build

COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B dependency:go-offline

COPY src ./src
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B package -DskipTests

# ---------------------------------------------------------------------------
# Stage 2: explode the repackaged fat jar into Spring Boot's standard layers
# (dependencies / snapshot-dependencies / spring-boot-loader / application).
# Spring Boot 3.5's Maven plugin produces a layered jar by default - no pom.xml
# configuration needed. Splitting layers here means the runtime image below
# gets one Docker layer per Spring Boot layer, so "I changed one controller"
# only invalidates the thin `application` layer, not the (large, rarely
# changing) `dependencies` layer.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-jammy AS layers
WORKDIR /layers
ARG JAR_FILE=/build/target/hydropark-backend-*.jar
COPY --from=build ${JAR_FILE} application.jar
RUN java -Djarmode=tools -jar application.jar extract --layers --launcher --destination extracted

# ---------------------------------------------------------------------------
# Stage 3: runtime. Small, non-root, and identical regardless of which trust
# zone this container will run as - the zone is chosen purely by env vars.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:21-jre-jammy AS runtime

# curl is only for the HEALTHCHECK below. Nothing else is added to the
# runtime image on top of the eclipse-temurin JRE base.
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root: a popped container should not even have the option of binding a
# privileged port or writing outside its own app directory.
RUN groupadd --system --gid 1000 hydropark \
    && useradd --system --uid 1000 --gid hydropark --no-create-home \
       --shell /usr/sbin/nologin hydropark

WORKDIR /application

COPY --from=layers /layers/extracted/dependencies/ ./
COPY --from=layers /layers/extracted/spring-boot-loader/ ./
COPY --from=layers /layers/extracted/snapshot-dependencies/ ./
COPY --from=layers /layers/extracted/application/ ./

RUN chown -R hydropark:hydropark /application
USER hydropark

EXPOSE 8080

# /actuator/health/readiness is `permitAll` in SecurityConfig (foundation
# code - not this package's to change) and reflects Spring's readiness
# AvailabilityState, which only flips to ACCEPTING_TRAFFIC once the
# ApplicationContext has fully started - true for whichever zone(s) this
# particular container is configured as. A container stuck mid-migration or
# failing to reach Mongo will correctly report unhealthy here.
HEALTHCHECK --interval=10s --timeout=3s --start-period=45s --retries=6 \
    CMD curl --fail --silent http://localhost:8080/actuator/health/readiness || exit 1

# Same entrypoint for api / issuer / worker / migrate - see the module-info
# comment at the top of this file. JarLauncher lives in the `spring-boot-loader`
# layer copied above (Spring Boot 3.2+ package path).
ENTRYPOINT ["java", "org.springframework.boot.loader.launch.JarLauncher"]
