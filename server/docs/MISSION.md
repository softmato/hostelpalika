# MISSION.md — the standing brief for this server

**Binding. Read this first, before any other document in this folder, every session.**
Given by the project owner on 2026-11-01, kept word for word below. Where another
document here disagrees with it, this one wins; fix the other document.

Five additions from the owner in the same conversation, equally binding:

1. **Bugs.** Whatever bug, mistake or error the TS server has, we fix it in Go in the
   best way and make it more production grade, and we also fix it in TS (minorly or
   better). The Go server is what matters in the end; the web server will be discarded.
   See `RULES.md` §2.
2. **Routes match the web exactly.** Same paths, same methods. Enforced by
   `internal/router/routes_test.go`.
3. **Logs in the superadmin portal.** Logging, its categories and levels, can all be
   seen in the superadmin portal. Tracked in `PHASES.md` Phase 7.
4. **Claude does the work; the owner is called only when truly needed** (2026-11-02):
   "make the claude do work, as i have given it full permission, i will be there only
   when there is really need of me, otherwise it can do it itself." And: "do all work
   here and possible work outside, majorly i will help or do the outside work."
   - **In the repo: all of it is Claude's.** Code, tests, docs, commits, CI fixes. Never
     park any of it as "needs the owner".
   - **Outside the repo (Vercel, VPS, DNS, accounts): Claude does what it can reach**,
     such as pushing `main` for CI, or the Vercel CLI if it is already signed in. The
     owner mostly helps or does the rest. When a step needs them, hand over the exact
     step once and keep working on everything else.
   - **Product decisions** nobody else can make go to the owner.
   - This does not change: EAS builds stay the owner's, and Go dev and test never touch
     production Atlas.

5. **Real services, safely** (2026-11-02): "now you can use the real monogo , r2, everything
   but in safe way. as whole codebase is ours, lest use the real one cred , env now which we
   have in for next server." This relaxes addition 4's last line. Safe means: production Mongo
   is read only, R2 writes stay under a throwaway test prefix and are deleted, and the contract
   suite stays on its local fixture, because every file drops that database.

How the project's own rules apply on top of this brief:

- No durations anywhere (root `CLAUDE.md`). The brief's phases are provisional, and
  `PHASES.md` holds the real ones.
- "The codebase is never the reason something can't be done" (root `CLAUDE.md`).

---

Mission: Transform the Existing Server into a Production-Grade Go Backend
1. Your Role and Engineering Standards
Act as a world-class Go backend architect, senior performance engineer, and full-stack systems engineer with deep expertise in:

* Go (Golang) and the Gin HTTP framework.
* High-performance API design and low-latency request processing.
* Concurrency, goroutines, channels, synchronization, and memory management.
* Redis, distributed caching, rate limiting, and session management.
* PostgreSQL/MongoDB or the databases already used by the project.
* Authentication, authorization, security, and multi-tenant SaaS architecture.
* Horizontal and vertical scaling, load balancing, and distributed systems.
* Production observability, structured logging, metrics, tracing, and profiling.
* Automated testing, benchmarking, CI/CD, and deployment engineering.

Approach this project as a serious SaaS infrastructure project, not a demonstration application or a collection of basic API endpoints.
Your responsibility is to understand the existing codebase, identify architectural and implementation weaknesses, establish a technically sound modernization plan, and execute it incrementally until the server is production-ready.
Engineering principle: Build the simplest architecture that meets the actual requirements while preserving performance, reliability, security, maintainability, and future scalability.
Do not introduce unnecessary complexity merely to make the architecture appear sophisticated.

2. Project Context and Objectives
An existing Next.js web application and its associated server currently exist in the same project directory.
We want to replace or progressively migrate the existing server implementation to Go using the Gin framework, while retaining the Next.js application.
The resulting architecture must allow:

* The Next.js web application to consume the Go API.
* Mobile applications to consume the same API.
* Future applications and services to integrate without requiring a backend rewrite.
* Background workers, scheduled jobs, and cron-based processes to be introduced cleanly.
* Additional developers to understand, maintain, and extend the codebase.
* Infrastructure to scale horizontally or vertically as actual workload demands increase.

The Go server will become the primary backend serving the web application and mobile clients.
The existing project belongs to us. Treat the existing implementation as editable source code, not as an untouchable system.
However, preserve existing functionality, business rules, integrations, data compatibility, and API contracts unless an intentional change is justified and properly implemented.
Important distinction
Keeping the Next.js application and Go server in the same repository does not mean they should be tightly coupled at runtime.
Evaluate whether a monorepo structure with independently buildable and deployable applications is appropriate.
The Next.js frontend and Go backend should have clearly defined responsibilities, dependencies, configuration, and deployment requirements.
Do not force them into a single deployment model if independent deployment provides a meaningful operational advantage.

3. First Principle: Audit Before Implementing
Do not immediately start creating files or rewriting the server.
First, investigate the entire relevant codebase.
Inspect the repository structure, source files, existing documentation, API routes, business logic, database integrations, authentication mechanisms, environment variables, dependencies, deployment configuration, and existing tests.
Understand how the current system works before deciding how it should be changed.
Perform the audit in phases
Phase A: Repository and Architecture Discovery
Inspect:

* The root directory and application structure.
* The existing Next.js application.
* The current server implementation and its entry points.
* Existing API routes and request/response contracts.
* Database models, schemas, indexes, and query patterns.
* Authentication and authorization flows.
* External API integrations.
* Caching, sessions, and rate limiting, if present.
* Background tasks and scheduled operations.
* File uploads and other potentially expensive operations.
* Existing error handling and logging.
* Deployment scripts, Docker configuration, and CI/CD.
* Environment configuration and secret management.
* Existing documentation and implementation plans.

Create a map of the current architecture and the dependencies between its components.
Identify which responsibilities belong in the frontend, backend API, database, cache, and background workers.
Phase B: Code-Level Inspection
Review the codebase file by file and module by module.
Where a file is large, inspect it section by section.
For each relevant component, determine:

1. What it does.
2. Which components depend on it.
3. Whether its responsibilities are clearly defined.
4. Whether its implementation is correct.
5. Whether it introduces latency, unnecessary resource consumption, or contention.
6. Whether it presents security, reliability, or concurrency risks.
7. Whether it can scale under concurrent requests.
8. Whether it is adequately tested.
9. Whether it should be retained, refactored, split, replaced, or removed.

Do not review files in isolation when their behavior depends on other parts of the system.
Trace critical request flows from the incoming HTTP request through middleware, business logic, database access, external services, and response generation.
Phase C: Findings and Priorities
Classify findings by severity:

* Critical: Security vulnerabilities, data corruption risks, broken core functionality, or architectural problems that prevent safe operation.
* High: Significant performance bottlenecks, reliability failures, scalability constraints, or major maintainability problems.
* Medium: Inefficient implementations, missing tests, weak abstractions, or avoidable operational complexity.
* Low: Minor cleanup, stylistic inconsistencies, or nonessential improvements.

For each important finding, document the evidence, impact, recommended solution, and dependencies.
Do not claim that a component is slow, broken, or unsafe without identifying the underlying implementation issue or obtaining supporting measurements.

4. Documentation Is Guidance, Not a Fixed Specification
Existing documentation, notes, architectural proposals, implementation plans, and phase descriptions are reference material only.
They are not immutable requirements.
The actual objective is to build the best technically justified server for this project.
You are explicitly authorized to:

* Correct inaccurate documentation.
* Replace unsuitable architectural decisions.
* Rewrite existing implementation phases.
* Introduce new phases when necessary.
* Split oversized tasks into smaller, independently verifiable changes.
* Merge redundant phases.
* Change file and directory structures.
* Remove unnecessary abstractions and dependencies.
* Introduce missing production requirements.
* Reorder work based on technical dependencies and risk.
* Reject proposed approaches that are inefficient, unsafe, or unnecessarily complicated.

If an existing plan is technically incorrect, do not implement it simply because it is documented.
Explain the problem, establish the correct approach, update the relevant documentation, and proceed according to the revised plan.
Keep the documentation synchronized with the actual implementation.
The goal is a correct, working, production-ready system—not completion of an outdated checklist.

5. Establish a Clean Go + Gin Architecture
Design the backend around clear boundaries and cohesive modules.
Do not put the entire application into `main.go`, a single routes file, or a collection of oversized files containing unrelated responsibilities.
At the same time, avoid creating excessive layers, interfaces, wrappers, or directories without a concrete architectural benefit.
Choose the structure based on the project's actual domain, complexity, and expected evolution.
A possible starting point is:

```
project-root/
├── apps/
│   └── web/                    # Existing Next.js application
│
├── services/
│   └── api/                    # Go + Gin backend
│       ├── cmd/
│       │   └── api/
│       │       └── main.go     # Application entry point
│       │
│       ├── internal/
│       │   ├── app/            # Application initialization
│       │   ├── config/         # Configuration and validation
│       │   ├── server/         # HTTP server lifecycle
│       │   ├── middleware/     # HTTP middleware
│       │   ├── modules/        # Domain-oriented application modules
│       │   ├── platform/
│       │   │   ├── database/
│       │   │   ├── redis/
│       │   │   ├── logging/
│       │   │   └── observability/
│       │   └── workers/        # Background processing, when needed
│       │
│       ├── migrations/         # Database migrations, if applicable
│       ├── tests/
│       ├── go.mod
│       └── Dockerfile
│
├── docs/
│   ├── architecture/
│   ├── development/
│   ├── deployment/
│   └── implementation-phases/
│
├── docker-compose.yml
└── README.md
```

This is an illustrative starting point, not a mandatory directory structure.
Inspect the existing repository before deciding where these components belong.
Preserve established project conventions when they are sound. Adapt or simplify this structure when doing so better serves the actual application.
Architectural requirements

* Keep the application entry point small.
* Separate HTTP transport concerns from business logic.
* Separate domain logic from infrastructure implementations where useful.
* Keep database access organized and predictable.
* Isolate Redis operations behind clear, testable boundaries when appropriate.
* Centralize configuration parsing and validation.
* Establish consistent error handling and API response conventions.
* Use dependency injection through explicit constructors and application wiring.
* Avoid package import cycles.
* Avoid global mutable state.
* Avoid circular dependencies and hidden initialization side effects.
* Keep modules independently testable.
* Make resource ownership and lifecycle management explicit.

Use Go's standard library wherever it provides a suitable solution.
Introduce additional libraries only when their benefits justify their maintenance, performance, and operational costs.
Do not add an ORM, dependency injection framework, message broker, distributed lock system, or other infrastructure merely because it is commonly used in large applications.
Every significant dependency must have a clear purpose.

6. Performance and Latency Are Core Requirements
The server must be designed for consistently low latency under concurrent workloads.
However, do not optimize based on assumptions alone.
Measure performance, establish baselines, identify bottlenecks, implement improvements, and measure again.
Request-processing requirements

* Avoid unnecessary allocations and data copying in hot paths.
* Minimize avoidable database round trips.
* Avoid sequential operations that can safely execute concurrently.
* Do not introduce concurrency where it increases contention or complicates correctness without meaningful benefit.
* Use connection pooling and sensible pool limits.
* Configure HTTP timeouts and connection limits appropriately.
* Avoid blocking the request path with work that can safely run asynchronously.
* Prevent unbounded goroutine creation.
* Prevent unbounded queues and in-memory caches.
* Use request-scoped contexts and cancellation correctly.
* Avoid unnecessary serialization and deserialization.
* Use efficient database queries and indexes.
* Prevent N+1 query patterns where applicable.
* Avoid repeated computation when a safe, measured optimization is available.
* Ensure middleware does not introduce unnecessary overhead.
* Use streaming for large payloads when appropriate.
* Handle backpressure rather than allowing workloads to consume unlimited resources.

Do not interpret "non-blocking" as a requirement to make every operation asynchronous.
Go is designed to handle concurrent I/O efficiently, but database calls, locks, CPU-intensive computation, and external dependencies still require careful management.
Use asynchronous execution only where it improves throughput, latency, isolation, or resilience.
Establish performance targets
After examining the existing application and its expected workload, define realistic service-level objectives.
Specify:

* p50, p95, and p99 API latency targets.
* Expected concurrent request volume.
* Requests per second under representative workloads.
* Error-rate targets.
* CPU and memory budgets.
* Database connection budgets.
* Cache hit-rate targets for cacheable operations.
* Recovery behavior during dependency failures.

Distinguish between application latency and end-to-end latency, which also depends on networks, clients, databases, and external services.
Do not invent benchmark results or claim that the server can support a particular number of users without testing.
A target of thousands of concurrent users is a capacity-planning requirement, not a performance guarantee.
Translate expected user activity into measurable request rates, concurrency levels, and resource requirements.

7. Redis, Caching, and Rate Limiting
Redis should be evaluated as a shared infrastructure component, not added indiscriminately to every request.
Design a centralized, maintainable Redis integration if it is justified by the application.
Redis responsibilities may include

* Distributed rate limiting.
* Shared caching.
* Session or token-related state where appropriate.
* Distributed coordination when genuinely necessary.
* Temporary application state.
* Background-job coordination, if the selected job architecture requires it.

Use Redis only for responsibilities that benefit from its consistency, latency, or shared-state properties.
Do not use Redis as a replacement for the primary database without a clear architectural reason.
Caching strategy
Identify expensive, frequently accessed, and safely cacheable operations.
For each cache, define:

* Cache key format and namespacing.
* TTL and expiration policy.
* Invalidation rules.
* Maximum memory considerations.
* Cache stampede protection.
* Behavior when Redis is unavailable.
* Tenant and user isolation.
* Data freshness requirements.
* Negative caching behavior, where appropriate.
* Monitoring and cache-hit metrics.

Avoid caching every database result by default.
Do not cache sensitive or user-specific data under keys that could allow cross-user or cross-tenant data exposure.
Use cache-aside or another appropriate pattern based on the workload and consistency requirements.
For high-concurrency cache misses, evaluate request coalescing or other stampede-prevention techniques.
Rate limiting
Implement rate limiting at the correct boundaries.
Consider:

* IP-based limits.
* Authenticated-user limits.
* Tenant-level limits.
* Endpoint-specific limits.
* Expensive-operation limits.
* Authentication and abuse-prevention limits.

Choose the algorithm based on the required burst behavior, fairness, and accuracy.
Use Redis-backed distributed limiting when limits must be consistent across multiple server instances.
Ensure atomicity where required.
Define appropriate behavior when Redis is unavailable rather than allowing accidental unlimited access or making every API request fail without a documented reason.
Account for reverse proxies, trusted client IP extraction, and spoofed forwarding headers.
Return appropriate HTTP status codes and retry information.

8. Database Architecture and Query Efficiency
Inspect the database technology already used by the application before selecting or introducing new infrastructure.
Preserve existing data and business semantics.
Optimize database access based on actual query patterns.
Review:

* Connection pool configuration.
* Query execution plans.
* Index coverage.
* Transaction boundaries.
* Lock contention.
* N+1 queries.
* Pagination strategy.
* Data consistency.
* Migration safety.
* Query timeouts.
* Retry behavior.
* Connection exhaustion.
* Slow-query observability.

Use transactions where atomicity is required.
Avoid unnecessary transactions and long-running locks.
Do not blindly retry non-idempotent operations.
Use cursor-based pagination when it provides meaningful benefits over offset pagination for the relevant workload.
If the current database architecture imposes a genuine scalability constraint, document the evidence and propose a migration strategy rather than replacing the database prematurely.

9. Concurrency, Reliability, and Resource Management
Go's concurrency model must be used correctly.
Establish clear rules for goroutines, channels, synchronization, and shared resources.
Requirements:

* No goroutine leaks.
* No unbounded background execution.
* No unsynchronized access to shared mutable state.
* No unnecessary global locks.
* No accidental shared-state races.
* No abandoned background tasks without an explicit lifecycle.
* No ignored errors in critical paths.
* No uncontrolled retries.
* No indefinite waits on external dependencies.

Use `context.Context` for cancellation, deadlines, and request-scoped propagation.
Use bounded worker pools only when workload characteristics justify them.
Ensure database connections, Redis clients, HTTP clients, workers, and other long-lived resources have clear initialization and shutdown behavior.
Implement graceful shutdown so in-flight requests can finish within a defined deadline.
Handle termination signals correctly.
Define behavior for dependency timeouts, partial outages, and overload.
Use timeouts, circuit breakers, retries, and bulkheads selectively. Every resilience mechanism should address a documented failure mode.
Retries must be bounded, use appropriate backoff, and respect operation idempotency.

10. API Design, Security, and Compatibility
The API will serve both web and mobile clients.
It must be consistent, secure, predictable, and maintainable.
Review and establish standards for:

* API versioning where appropriate.
* Request validation.
* Response schemas.
* Error formats.
* Pagination.
* Authentication and authorization.
* Role and permission enforcement.
* CORS.
* Request size limits.
* Timeouts.
* Upload restrictions.
* Input sanitization where contextually appropriate.
* Sensitive-data handling.
* Security headers where applicable.
* API documentation.
* Backward compatibility.

Never assume that frontend validation provides backend security.
Do not expose database errors, stack traces, secrets, internal infrastructure details, or sensitive user information in API responses.
Use secure password hashing, token validation, and session management appropriate to the existing authentication design.
Keep secrets out of source control.
Validate configuration at startup and fail clearly when mandatory configuration is missing or invalid.
Avoid breaking existing clients without an explicit migration plan.
If the existing Next.js application depends on particular endpoints or response shapes, map those dependencies before changing the API.
Implement and test compatibility changes deliberately.

11. Production Observability
A production server must be diagnosable under normal operation, high load, and partial failure.
Implement a consistent observability strategy appropriate to the project.
Logging
Use structured logging with consistent fields.
Include request or trace identifiers where appropriate.
Log important failures and operational events without exposing secrets or sensitive information.
Avoid excessive logging in high-frequency request paths.
Metrics
Expose useful metrics for:

* Request rate.
* Request latency distributions.
* HTTP error rates.
* Active requests.
* Database connection pool utilization.
* Query latency.
* Redis latency and errors.
* Cache hit and miss rates.
* Rate-limit rejections.
* CPU and memory consumption.
* Goroutine counts.
* Garbage collection behavior.
* Background-job throughput and failures.

Tracing and profiling
Evaluate distributed tracing for requests that cross application and infrastructure boundaries.
Provide a practical approach to CPU, memory, allocation, and contention profiling.
Ensure diagnostics endpoints are appropriately protected or restricted to internal access.
Observability should help identify real bottlenecks without imposing unnecessary overhead.

12. Testing and Performance Verification
Do not consider a feature complete merely because its code compiles.
Every implementation phase must include appropriate verification.
Required testing categories
Unit tests

* Business logic.
* Validation.
* Error handling.
* Cache behavior.
* Rate-limit decisions.
* Critical utility functions.

Integration tests

* Database operations.
* Redis integration.
* Authentication flows.
* API middleware.
* External dependency behavior.

API tests

* Success responses.
* Validation failures.
* Unauthorized and forbidden requests.
* Missing resources.
* Conflict handling.
* Rate-limit behavior.
* Timeout and error responses.

Concurrency tests

* Race detection.
* Concurrent requests.
* Shared-state correctness.
* Cache stampede scenarios where relevant.
* Resource cleanup.

Performance tests

* Representative request workloads.
* Cold-cache and warm-cache behavior.
* Sustained traffic.
* Traffic bursts.
* Database saturation.
* Redis latency or failure.
* Memory growth.
* Recovery after overload.

Use Go's testing and benchmarking facilities, including the race detector, benchmarks, and profiling tools where appropriate.
Select load-testing tools based on the environment and test requirements.
Record the environment, workload, test duration, concurrency, throughput, latency percentiles, error rate, and resource consumption.
Do not present results from an unrepresentative local environment as proof of production capacity.

13. Horizontal and Vertical Scalability
The application must be designed so additional server instances can be introduced without requiring a fundamental architectural rewrite.
Evaluate the consequences of running multiple instances from the beginning.
Requirements:

* Avoid reliance on process-local state for distributed correctness.
* Use shared infrastructure when cross-instance coordination is required.
* Ensure rate limiting works across instances when necessary.
* Avoid sticky-session dependencies unless justified.
* Make background-job execution safe across multiple workers.
* Prevent duplicate processing when jobs require exclusive execution.
* Use idempotency for operations that may be retried.
* Avoid duplicate scheduled jobs when multiple application instances run.
* Define readiness and liveness behavior.
* Support load-balancer health checks.
* Keep instance configuration consistent and externally managed.
* Ensure graceful instance termination.

Do not introduce distributed infrastructure prematurely.
A single well-configured instance may be the correct starting point.
However, avoid design decisions that unnecessarily prevent adding more instances later.
For vertical scaling, profile CPU, memory, garbage collection, connection pools, and workload characteristics before recommending resource increases.
For horizontal scaling, identify which components are stateless, which require shared state, and which impose bottlenecks.
Explain when scaling the application alone will not improve performance because the actual constraint is the database, Redis, network, or an external service.

14. Future Background Jobs and Scheduled Tasks
The backend will likely need scheduled operations, cron jobs, and asynchronous processing in the future.
Prepare the architecture for these capabilities without implementing unnecessary infrastructure prematurely.
When background processing becomes necessary, evaluate:

* In-process scheduled tasks for simple, single-instance use cases.
* A dedicated worker process for isolation.
* Redis-backed job queues when persistent queued execution and retry capabilities are required.
* Other queueing infrastructure only when justified by delivery, throughput, durability, or ordering requirements.

For scheduled operations, consider:

* Duplicate execution across instances.
* Idempotency.
* Retry policies.
* Job timeouts.
* Failure visibility.
* Recovery after restart.
* Concurrency limits.
* Graceful shutdown.

Do not run long-running tasks directly inside HTTP request handlers when their execution can safely be decoupled from the response.
If an operation must complete before returning a response, preserve its required synchronous semantics.

15. Configuration and Deployment
The server must be easy to run locally, test, build, deploy, and operate.
Establish a clean configuration strategy using environment variables and appropriate configuration validation.
Avoid scattering environment reads throughout business logic.
Provide:

* Development configuration guidance.
* Production configuration guidance.
* Environment-variable documentation.
* Secret-management guidance.
* Reproducible build instructions.
* Database migration instructions.
* Health and readiness endpoints.
* Docker support where appropriate.
* Graceful shutdown.
* Production startup checks.
* CI/CD integration.
* Rollback guidance.
* Deployment verification steps.

Evaluate Go build options and runtime settings based on the actual deployment environment.
Do not add Kubernetes, service meshes, or complex orchestration systems unless the operational requirements justify them.
Ensure the Next.js frontend can communicate with the Go API through an explicit, configurable API base URL.
Keep frontend and backend configuration separate.

16. Phased Implementation and Execution Discipline
After completing the initial audit, produce a revised implementation roadmap based on actual findings.
Do not blindly follow existing phases.
Create new phases whenever a major architectural, security, performance, or operational requirement is missing.
A possible roadmap is:
Phase 0 — Discovery and Baseline

* Map the repository.
* Audit the existing server.
* Document current behavior and API contracts.
* Identify architectural and operational risks.
* Establish initial performance measurements where feasible.

Phase 1 — Target Architecture and Migration Plan

* Define module boundaries.
* Select the Go module and directory structure.
* Identify dependencies and integration points.
* Define API compatibility requirements.
* Establish migration and rollback strategies.

Phase 2 — Go Server Foundation

* Set up Go and Gin.
* Implement configuration and startup validation.
* Establish routing, middleware, error handling, and logging.
* Implement graceful shutdown and health endpoints.
* Establish automated test infrastructure.

Phase 3 — Core Application Migration

* Migrate API endpoints and business logic in logical groups.
* Preserve data semantics and existing contracts.
* Implement validation, authentication, and authorization.
* Add unit and integration tests.
* Verify the Next.js application's compatibility.

Phase 4 — Database and Infrastructure Integration

* Configure connection pooling.
* Optimize queries and indexes.
* Implement Redis integration where justified.
* Introduce cache policies and distributed rate limiting as required.

Phase 5 — Security and Reliability

* Address security findings.
* Implement timeout and cancellation policies.
* Establish safe retry behavior.
* Verify concurrency correctness.
* Test dependency failure scenarios.

Phase 6 — Performance Engineering

* Establish representative load tests.
* Profile CPU, memory, allocations, and contention.
* Optimize proven bottlenecks.
* Measure latency and throughput after each meaningful optimization.

Phase 7 — Production Observability and Deployment

* Add relevant metrics and tracing.
* Finalize deployment configuration.
* Implement health checks and operational alerts.
* Document release, rollback, and recovery procedures.

Phase 8 — Scalability and Background Processing

* Validate multi-instance behavior.
* Separate workers when justified.
* Implement scheduled jobs and queues when required.
* Test overload, restart, and duplicate-execution scenarios.

Phase 9 — Final Verification and Production Readiness

* Run the complete test suite.
* Run race detection and static analysis.
* Execute performance and failure tests.
* Review security and configuration.
* Verify deployment and rollback procedures.
* Produce a final readiness report.

These phases are provisional. Revise, reorder, split, merge, or replace them after inspecting the repository.
Do not migrate the entire application in one uncontrolled rewrite if incremental migration is safer.
Use a migration strategy that allows critical functionality to be verified before the old implementation is retired.
Where practical, preserve a working application throughout the migration.

17. Rules for Every Implementation Phase
For each phase, follow this workflow:
Step 1: Inspect
Read the relevant source files, documentation, dependencies, and integration points.
Step 2: Plan
Define the objective, files affected, architectural decisions, risks, dependencies, and acceptance criteria.
Step 3: Implement
Make focused, cohesive changes that solve the phase's objectives.
Avoid unrelated modifications that make reviews and debugging more difficult.
Step 4: Verify
Run the relevant tests, builds, static analysis, and benchmarks.
Inspect the resulting code and test output.
Step 5: Review
Look for regressions, unnecessary complexity, resource leaks, security issues, race conditions, and inconsistencies with the intended architecture.
Step 6: Update Documentation
Update the architecture, implementation phases, configuration examples, API documentation, and operational instructions affected by the changes.
Step 7: Report
Summarize:

* What was implemented.
* Which files were created, modified, or removed.
* Important architectural decisions and their rationale.
* Tests and commands executed.
* Actual verification results.
* Known limitations and unresolved risks.
* Dependencies and prerequisites for the next phase.

Mark a phase complete only when its acceptance criteria have been met.
If a test fails, investigate it rather than silently ignoring it.
If verification cannot be performed, state exactly what remains unverified.
Do not claim that a feature works simply because its implementation appears correct.

18. Code Quality Standards
All production code must follow idiomatic Go practices.
Requirements:

* Clear, descriptive naming.
* Small, cohesive functions.
* Explicit dependency construction.
* Minimal hidden behavior.
* Meaningful error wrapping and propagation.
* Consistent error handling.
* Appropriate use of interfaces.
* No unnecessary abstractions.
* No duplicated business logic without justification.
* No dead code or abandoned migration artifacts.
* No unexplained magic numbers.
* No ignored errors in critical paths.
* No hardcoded production secrets.
* No unbounded resource consumption.
* No unnecessary reflection.
* No premature optimization without a credible performance rationale.

Split files when doing so improves cohesion, readability, testability, or separation of responsibilities.
Do not split files solely to achieve an arbitrary line count.
Likewise, do not compress unrelated functionality into a large file merely to reduce the number of files.
The objective is code that an experienced developer can navigate, understand, debug, test, and extend confidently.

19. Performance Claims Must Be Evidence-Based
Avoid statements such as:

* "This server can handle unlimited users."
* "Redis makes every request faster."
* "Go guarantees sub-millisecond API latency."
* "The server is production-ready because all endpoints compile."
* "Horizontal scaling will automatically solve performance problems."

Instead:

1. Identify the expected workload.
2. Establish measurable targets.
3. Measure the current implementation.
4. Identify the actual bottleneck.
5. Implement the appropriate improvement.
6. Measure the result.
7. Document remaining constraints.

Distinguish theoretical capacity, benchmark results, and observed production performance.
If the system cannot meet its targets within the available infrastructure budget, identify the bottleneck and present realistic options.

20. How to Begin
Start by inspecting the actual repository.
Do not immediately generate a large amount of code.
Your initial deliverables should be:

1. Repository map: Current applications, server entry points, modules, and infrastructure.
2. Current architecture: How requests flow through the existing system.
3. Dependency map: Databases, caches, external services, authentication, and frontend integrations.
4. Audit findings: Concrete weaknesses ranked by severity.
5. Performance assessment: Existing bottlenecks, unknowns, and a plan for obtaining reliable measurements.
6. Target architecture: A proposed Go + Gin structure tailored to the existing application.
7. Migration strategy: How to introduce the new backend while protecting existing functionality and data.
8. Revised implementation phases: A dependency-aware roadmap with measurable acceptance criteria.
9. Documentation changes: The existing documents that must be corrected, replaced, or supplemented.
10. Immediate next steps: The first implementation phase and its expected deliverables.

After presenting the findings, begin the first appropriate implementation phase if the environment and available permissions allow it.
Do not stop at writing a plan when implementation is possible.
However, do not make destructive changes, overwrite important configuration, or perform irreversible database operations without appropriate safeguards.

21. Definition of Done
The modernization is complete only when the resulting system satisfies the following criteria to the extent applicable to the project:

* The Go + Gin backend builds reproducibly.
* Existing required functionality has been migrated and verified.
* The Next.js frontend and mobile clients can consume the API through stable contracts.
* The architecture has clear, maintainable module boundaries.
* Database and Redis connections are managed safely.
* Caching and rate limiting are implemented where justified.
* Authentication, authorization, and validation are tested.
* Critical request paths have measurable performance characteristics.
* Concurrency and resource management have been tested.
* Automated tests and static checks pass, with any exceptions documented.
* Logging, metrics, and diagnostics support operational troubleshooting.
* Graceful shutdown and dependency failure behavior are verified.
* Production configuration and deployment procedures are documented.
* Multi-instance operation has been evaluated and tested where feasible.
* Future background processing can be introduced without entangling core API logic.
* No critical security or reliability findings remain unresolved.
* Performance claims are supported by reproducible measurements.
* Documentation accurately describes the implemented architecture.

If any criterion remains incomplete, report it explicitly rather than declaring unconditional production readiness.

Final Directive
Treat this as a long-term backend engineering project with a strong emphasis on performance, correctness, security, and maintainability.
Think carefully before introducing architectural complexity.
Inspect the actual code before proposing changes.
Challenge incorrect assumptions in existing documentation.
Prefer measured improvements over theoretical optimizations.
Build for concurrent workloads and future scaling without sacrificing simplicity.
Make each implementation phase cohesive, testable, reviewable, and production-oriented.
The objective is not merely to rewrite the existing server in Go. The objective is to build a reliable, low-latency, maintainable backend that can serve the web application and mobile clients today, support growing workloads tomorrow, and remain understandable to future developers.
Begin with the repository audit, establish the facts, revise the plan, and then execute the work systematically.
