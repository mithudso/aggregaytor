# Software architect context

## How to use this context

Use this file as a **practical software architecture reference** when designing systems, reviewing architectures, planning modernization, or making cross-cutting technical decisions. Treat **ISO/IEC/IEEE 42010** as the source of truth for architecture description concepts, **arc42** and **C4** as the source of truth for practical documentation and visualization approaches, **SEI** as the source of truth for architecture evaluation and quality-attribute tradeoff analysis, and **AWS/Azure/Google Cloud** well-architected guidance as the source of truth for operational cloud architecture review themes ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html), [arc42 overview](https://arc42.org/overview), [C4 model home](https://c4model.com/), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/), [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure Well-Architected](https://learn.microsoft.com/en-us/azure/well-architected/), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

**Version note:** this file is based on the current official pages accessed on **2026-05-10**. The ISO overview page explicitly marks **ISO/IEC/IEEE 42010:2011** as **withdrawn**, but its abstract still provides the architecture-description concepts requested in the task, so this file uses it with that status called out explicitly ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)). The AWS framework page is dated **2024-11-06**, and the Google Cloud framework page was last reviewed **2026-01-28** ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

## Source scope

- **Architecture-description concepts:** ISO/IEC/IEEE 42010 abstract for architecture descriptions, viewpoints, frameworks, and architecture description languages ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).
- **Practical architecture documentation structure:** arc42 overview plus section docs for context/scope, architecture decisions, and quality requirements ([arc42 overview](https://arc42.org/overview), [arc42 docs home](https://docs.arc42.org/home/), [arc42 section 3](https://docs.arc42.org/section-3/), [arc42 section 9](https://docs.arc42.org/section-9/), [arc42 section 10](https://docs.arc42.org/section-10/)).
- **Visualization and decomposition abstractions:** C4 model abstractions, diagram types, and notation guidance ([C4 model home](https://c4model.com/), [C4 abstractions](https://c4model.com/abstractions), [C4 diagrams](https://c4model.com/diagrams), [C4 notation](https://c4model.com/diagrams/notation)).
- **Architecture evaluation and tradeoff analysis:** SEI Architecture Tradeoff Analysis Method collection and ATAM overview material ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/), [SEI architecture evaluation talk](https://www.sei.cmu.edu/library/architecting-software-the-sei-way-architecture-evaluation-a-tool-for-designing-systems-that-meet-users-needs/)).
- **Cloud architecture review themes and operational guidance:** AWS, Azure, and Google Cloud official architecture centers/frameworks ([AWS Well-Architected home](https://aws.amazon.com/architecture/well-architected/), [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure Well-Architected](https://learn.microsoft.com/en-us/azure/well-architected/), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars), [Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/), [Azure reference architectures](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework), [Google Cloud Architecture Center](https://cloud.google.com/architecture)).

## Quick architecture rules

1. Start architecture work from **stakeholders, concerns, goals, and constraints**, not from technology first; ISO 42010 and arc42 both frame architecture description around stakeholders, concerns, and the content needed to communicate decisions ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html), [arc42 overview](https://arc42.org/overview)).
2. Document architecture with **multiple views** because no single diagram or narrative serves every audience; use views that match stakeholder concerns and system questions ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html), [arc42 overview](https://arc42.org/overview), [C4 diagrams](https://c4model.com/diagrams)).
3. Make boundaries and interfaces explicit early: arc42 treats context/scope and external interfaces as critical, and C4 starts with system context before zooming inward ([arc42 section 3](https://docs.arc42.org/section-3/), [C4 diagrams](https://c4model.com/diagrams)).
4. Prefer architecture documentation that is **clear, useful, maintained, and scoped to use cases**, not documentation volume for its own sake ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework), [arc42 docs home](https://docs.arc42.org/home/)).
5. Record **architecturally significant decisions** with rationale and consequences so later teams can retrace why the system looks the way it does ([arc42 section 9](https://docs.arc42.org/section-9/)).
6. Make quality attributes concrete with **quality scenarios** and analyze their tradeoffs explicitly; SEI ATAM and arc42 both depend on scenario-driven quality reasoning ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/), [arc42 section 10](https://docs.arc42.org/section-10/)).
7. Use the simplest architecture that meets current needs, and resist over-engineering; Google Cloud explicitly recommends simplicity, managed services where feasible, and incremental change ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
8. Treat architecture review as an ongoing **constructive evaluation process**, not just a final audit; AWS explicitly frames well-architected reviews as constructive conversations, and SEI ATAM exposes risks and tradeoffs early enough to change direction ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).

## Architecture workflow

1. **Capture goals, stakeholders, and constraints.** Start with requirements, top quality goals, stakeholder expectations, and constraints before discussing structure ([arc42 overview](https://arc42.org/overview)).
2. **Delimit the system and its context.** Identify the business and technical context, communication partners, and external interfaces ([arc42 section 3](https://docs.arc42.org/section-3/)).
3. **Choose a view set that fits the audience.** Use viewpoint-driven documentation concepts from ISO, a pragmatic documentation template like arc42, and C4 diagram levels that match the question being answered ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html), [arc42 docs home](https://docs.arc42.org/home/), [C4 diagrams](https://c4model.com/diagrams)).
4. **Define decomposition and interactions.** Describe static structure, runtime behavior, deployment, and cross-cutting concepts so both structure and operation are visible ([arc42 overview](https://arc42.org/overview), [C4 abstractions](https://c4model.com/abstractions)).
5. **Turn quality goals into measurable scenarios.** Use arc42 quality scenarios and, where needed, SEI-style quality-attribute reasoning to make tradeoffs testable and explicit ([arc42 section 10](https://docs.arc42.org/section-10/), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
6. **Evaluate the architecture.** Use ATAM-style scenario analysis to identify risks, non-risks, sensitivity points, tradeoff points, and risk themes before implementation locks decisions in ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
7. **Run a cloud-operational review when relevant.** Check the architecture against AWS/Azure/GCP well-architected pillars and review tools for security, reliability, performance, operations, cost, and related concerns ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
8. **Record decisions, risks, and change history.** Keep ADRs, technical debt, risks, and documentation updates current as the system evolves ([arc42 section 9](https://docs.arc42.org/section-9/), [arc42 overview](https://arc42.org/overview), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

## Software architecture goals and architect mindset

- ISO 42010 frames architecture work around the **creation, analysis, and sustainment** of architectures using architecture descriptions rather than ad hoc commentary ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).
- arc42 presents architecture communication as a pragmatic answer to two questions: **what** should be documented and **how** it should be communicated ([arc42 overview](https://arc42.org/overview)).
- The cloud frameworks all treat architecture as business-facing, not purely technical: Azure says workloads should achieve **business value over time**, AWS says well-architected systems increase the likelihood of business success, and Google Cloud ties documentation quality and changeability to organizational performance ([Azure Well-Architected](https://learn.microsoft.com/en-us/azure/well-architected/), [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- The architect’s job is therefore to make the system understandable, evolvable, and reviewable while balancing quality concerns instead of optimizing a single dimension in isolation ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)).

## Architecture description and documentation approaches

### ISO/IEC/IEEE 42010 concepts

- ISO/IEC/IEEE 42010 introduces a **conceptual model for architecture description** and specifies required contents for architecture descriptions, architecture viewpoints, architecture frameworks, and architecture description languages ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).
- The practical takeaway is that architecture documentation should be intentional about the conventions and viewpoints it uses, rather than being an accidental pile of diagrams and notes ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).

### arc42 documentation structure

- arc42 provides a pragmatic, open-source template for architecture communication and documentation, organized into sections for goals, constraints, context, solution strategy, building blocks, runtime, deployment, cross-cutting concepts, decisions, quality requirements, risks/technical debt, and glossary ([arc42 overview](https://arc42.org/overview), [arc42 docs home](https://docs.arc42.org/home/)).
- arc42 is explicitly **systematic but flexible**, and tags its guidance as lean, thorough, or essential depending on documentation depth and context ([docs.arc42.org home](https://docs.arc42.org/home/)).
- arc42’s context/scope section emphasizes that business and technical context can be documented separately when needed, which helps different stakeholders reason about inputs/outputs versus channels/protocols/hardware ([arc42 section 3](https://docs.arc42.org/section-3/)).

### C4 visualization approach

- C4 is an **abstraction-first**, developer-friendly approach to diagramming software architecture built around a small set of abstractions and hierarchical diagrams ([C4 model home](https://c4model.com/), [C4 abstractions](https://c4model.com/abstractions)).
- The core abstractions are **software systems, containers, components, and code**, and the core diagram set mirrors those levels with optional supporting diagrams such as system landscape, dynamic, and deployment diagrams ([C4 model home](https://c4model.com/), [C4 abstractions](https://c4model.com/abstractions), [C4 diagrams](https://c4model.com/diagrams)).
- C4 explicitly says you do **not** need to use all four levels; most teams get sufficient value from system context and container diagrams alone ([C4 diagrams](https://c4model.com/diagrams)).
- C4 is **notation independent**, but diagrams should stand alone, have titles, a key/legend, explicit element types, short descriptions, and labeled relationships with direction and technology/protocol where relevant ([C4 notation](https://c4model.com/diagrams/notation)).

## Views, stakeholders, concerns, and decision records

- ISO 42010’s overview explicitly introduces **viewpoints** and architecture frameworks as the way to codify architecture-description conventions and practices ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).
- arc42 section 1 and section 10 connect stakeholder expectations, top quality goals, and quality requirements, making stakeholder concerns a first-class documentation input ([arc42 overview](https://arc42.org/overview), [arc42 section 10](https://docs.arc42.org/section-10/)).
- arc42 section 9 recommends documenting **important, expensive, large-scale, or risky architecture decisions including rationales**, and explicitly recommends ADRs as a practical form ([arc42 section 9](https://docs.arc42.org/section-9/)).
- arc42’s ADR guidance follows Nygard-style fields such as **Title, Context, Decision, Status, and Consequences**, with consequences including positive, negative, and neutral effects rather than just benefits ([arc42 section 9](https://docs.arc42.org/section-9/)).
- Google Cloud’s framework reinforces the same idea operationally: architecture documentation should include design decisions and change history because future teams need that context to avoid duplication and understand why the system evolved as it did ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

## Quality attributes and tradeoff analysis

- arc42 says quality requirements strongly influence architecture decisions and should be known in a **specific and measurable** way ([arc42 section 10](https://docs.arc42.org/section-10/)).
- arc42 distinguishes **usage scenarios** and **change scenarios**, which makes quality discussion cover both runtime behavior and evolvability/change cost ([arc42 section 10](https://docs.arc42.org/section-10/)).
- SEI’s ATAM is explicitly a method for evaluating architectures **relative to quality attribute goals** and for exposing how quality goals interact and trade off against each other ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- ATAM’s outputs include **risks, non-risks, sensitivity points, tradeoff points, and risk themes**, which makes it useful not just for pass/fail evaluation but for explaining why one quality goal stresses another ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- Azure’s pillars page makes tradeoffs explicit as a normal part of architecture work by linking every pillar to both principles and **tradeoffs** ([Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)).

## Architecture evaluation and review methods

- ATAM is SEI’s primary method here: it evaluates software architectures against quality goals, typically over **three to four days**, with a trained evaluation team, architects, and stakeholder representatives ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- ATAM’s nine documented steps cover presenting the method, business drivers, the architecture, identifying approaches, generating a utility tree, analyzing approaches, brainstorming/prioritizing scenarios, re-analyzing against top scenarios, and presenting results ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- SEI also notes that ATAM techniques can be integrated into the **architecture design process continuously**, instead of being saved only for a late one-time review ([SEI architecture evaluation talk](https://www.sei.cmu.edu/library/architecting-software-the-sei-way-architecture-evaluation-a-tool-for-designing-systems-that-meet-users-needs/)).
- AWS provides a complementary operational review method through the **AWS Well-Architected Tool**, which offers a consistent process for reviewing workloads and identifying high-risk issues and improvements ([AWS Well-Architected home](https://aws.amazon.com/architecture/well-architected/), [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)).
- Azure provides an **Azure Well-Architected Review** assessment and Azure Advisor/Azure Advisor score to assess workload posture and prioritize improvements by pillar ([Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)).

## Decomposition, boundaries, interfaces, and integration patterns

- arc42’s context/scope guidance says the system should be delimited from communication partners and external interfaces, optionally separating **business context** from **technical context** ([arc42 section 3](https://docs.arc42.org/section-3/)).
- C4 gives a practical decomposition ladder: people interact with software systems, which contain containers, which contain components, which are implemented by code elements ([C4 abstractions](https://c4model.com/abstractions)).
- C4’s system context and container diagrams are the main review surfaces for understanding system boundaries, external dependencies, and internal runtime/application building blocks ([C4 diagrams](https://c4model.com/diagrams)).
- arc42’s building block, runtime, and deployment sections complement that by covering **static decomposition**, **runtime scenarios**, and **mapping to infrastructure** ([arc42 overview](https://arc42.org/overview)).
- Google Cloud’s framework explicitly recommends **decoupling** architecture into smaller independently operating components when appropriate, because that improves changeability, security-control placement, reliability goals, monitoring, performance tuning, and cost control ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- Google Cloud also explicitly recommends **stateless architecture** where feasible because it improves scalability and reliability by reducing local dependencies and making restart behavior simpler ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

## Cloud architecture guidance and well-architected themes

### AWS

- AWS organizes architecture review around six pillars: **operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability** ([AWS Well-Architected home](https://aws.amazon.com/architecture/well-architected/), [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)).
- AWS explicitly says the review process is a **constructive conversation about architectural decisions**, not an audit mechanism ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)).

### Azure

- Azure frames the architect’s job as building workloads that are **reliable, secure, and performant** while maximizing infrastructure investment value over time ([Azure Well-Architected](https://learn.microsoft.com/en-us/azure/well-architected/)).
- Azure’s five pillars are **Reliability, Security, Cost Optimization, Operational Excellence, and Performance Efficiency**, and each pillar links principles to explicit tradeoffs ([Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)).
- Azure Architecture Center provides reference architectures, examples, and technology descriptions for common workloads on Azure ([Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/), [Azure reference architectures](https://learn.microsoft.com/en-us/azure/architecture/reference-architectures/)).

### Google Cloud

- Google Cloud’s framework organizes guidance into six pillars: **security, reliability, performance, cost, operations, and sustainability**, plus cross-pillar perspectives for specific sectors or technologies ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- Google Cloud’s documented core principles include **design for change**, **document your architecture**, **simplify your design and use fully managed services**, **decouple your architecture**, and **use a stateless architecture** ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- Google Cloud Architecture Center is the umbrella entry point for foundational and domain-specific architecture guidance ([Google Cloud Architecture Center](https://cloud.google.com/architecture)).

## Evolution, modernization, and change management

- Google Cloud explicitly frames systems as **never static**, and recommends building a process that enables small regular changes with fast feedback ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- arc42’s risks/technical debt and architecture decisions sections make architectural evolution visible by capturing known problems, technical debt, and the decisions that caused or mitigated them ([arc42 overview](https://arc42.org/overview), [arc42 section 9](https://docs.arc42.org/section-9/)).
- Azure’s well-architected framing is explicitly about achieving business value **over time**, which makes architecture a continuing design activity rather than a one-off upfront deliverable ([Azure Well-Architected](https://learn.microsoft.com/en-us/azure/well-architected/)).

## Methods, views, frameworks, and review surfaces inventory

This is a **condensed high-value inventory** of the architecture methods, views, and review surfaces from the source material.

| Method / framework / view | Purpose | Key inputs / elements | Output / effect | Typical usage | Caveats / scope limits |
|---|---|---|---|---|---|
| ISO/IEC/IEEE 42010 architecture description | Define the contents and concepts of architecture descriptions ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)) | Architecture descriptions, viewpoints, frameworks, ADLs | Conceptual model and required content guidance | Formal architecture description | Overview page is for a withdrawn 2011 edition |
| arc42 template | Structure architecture communication/documentation pragmatically ([arc42 overview](https://arc42.org/overview), [docs arc42 home](https://docs.arc42.org/home/)) | Goals, constraints, context, solution strategy, views, decisions, quality, risks | A consistent doc set | Team-level architecture docs | Template is flexible; still needs judgment on depth |
| Business context view | Show communication partners and domain inputs/outputs ([arc42 section 3](https://docs.arc42.org/section-3/)) | System, users, neighboring systems, domain interfaces | Shared understanding of external domain boundaries | Scope and interface clarification | Can miss technical channels if used alone |
| Technical context view | Show channels, protocols, hardware/media ([arc42 section 3](https://docs.arc42.org/section-3/)) | Technical interfaces and mappings | Infrastructure-facing interface clarity | Integration and deployment planning | Should be linked back to business I/O |
| C4 system context diagram | Show system in its environment ([C4 diagrams](https://c4model.com/diagrams)) | System, people, neighboring systems | External boundary map | Early architecture communication | Often enough with container diagram for many teams |
| C4 container diagram | Show applications/data stores inside the system ([C4 diagrams](https://c4model.com/diagrams)) | Containers and inter-container relationships | High-level internal decomposition | Service/app/data-store architecture | Not meant for low-level class detail |
| C4 component diagram | Show major components inside a container ([C4 diagrams](https://c4model.com/diagrams)) | Components and responsibilities | Finer-grained decomposition | Larger or more complex containers | Optional; only add if it brings value |
| C4 deployment diagram | Show deployment topology ([C4 diagrams](https://c4model.com/diagrams)) | Infrastructure nodes and deployed elements | Runtime/infrastructure mapping | Operations and deployment review | Supplementary, not always required |
| C4 notation guidance | Make diagrams self-describing and reviewable ([C4 notation](https://c4model.com/diagrams/notation)) | Titles, legend, typed elements, descriptions, labeled relationships | Clearer diagrams | Reviewing architecture diagrams | C4 is notation independent, so teams still choose notation |
| ADR | Record significant decisions and rationale ([arc42 section 9](https://docs.arc42.org/section-9/)) | Context, decision, status, consequences | Decision history | Architecture governance and change tracking | Document only architecturally significant decisions |
| Quality scenarios | Make quality requirements specific and measurable ([arc42 section 10](https://docs.arc42.org/section-10/)) | Source/stimulus/context/response/measure | Testable quality expectations | Performance, reliability, operability, changeability | Requires discipline to keep scenarios measurable |
| Utility tree | Prioritize quality scenarios and drivers ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)) | Quality factors, scenarios, priorities | Structured quality-attribute focus | ATAM and tradeoff analysis | Reflects current stakeholder priorities only |
| ATAM | Evaluate architecture against quality goals and tradeoffs ([SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)) | Business drivers, scenarios, approaches, stakeholders | Risks, non-risks, sensitivity points, tradeoff points, risk themes | Formal architecture evaluation | Typically multi-day and stakeholder-intensive |
| AWS Well-Architected Framework | Review cloud workload architecture on six pillars ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)) | Foundational questions and pillar guidance | Improvement areas and remediation direction | AWS workload review | AWS-specific cloud framing |
| Azure Well-Architected pillars | Review workload concerns, principles, and tradeoffs by pillar ([Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)) | Pillars, principles, tradeoffs | Improvement opportunities and assessment framing | Azure workload review | Azure-specific framing; tradeoffs are pillar-relative |
| Google Cloud Well-Architected Framework | Review cloud architecture with pillars and core principles ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)) | Pillars, perspectives, core principles | Architecture recommendations and modernization guidance | Google Cloud or multi-cloud architectural review | Cloud-specific; should be combined with system-level views |

## Architecture standards and best practices

### Documentation quality

- Use architecture documentation that is **clear, useful, maintained, and audience-aware** rather than exhaustive but stale; Google Cloud explicitly says quality documentation is about clarity, usefulness, and maintenance, not volume ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- Use structured sections for goals, constraints, context, solution strategy, runtime, deployment, quality, risks, and glossary so stakeholders can find the part they need ([arc42 overview](https://arc42.org/overview), [docs arc42 home](https://docs.arc42.org/home/)).

### Stakeholder- and concern-driven design

- Architecture views should be chosen to answer stakeholder questions and concerns, not because a template exists ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html), [arc42 overview](https://arc42.org/overview)).
- Quality goals should be explicit and prioritized because they drive architectural decisions and tradeoffs ([arc42 overview](https://arc42.org/overview), [arc42 section 10](https://docs.arc42.org/section-10/)).

### Decision recording

- Record important decisions in ADR form with **context, decision, status, and consequences**, and keep consequences balanced rather than listing only upsides ([arc42 section 9](https://docs.arc42.org/section-9/)).
- Maintain change history because future architects need the system’s design history to onboard and make compatible decisions ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

### Interface and boundary clarity

- Delimit system scope from neighboring systems and users and specify both business and technical interfaces when that distinction matters ([arc42 section 3](https://docs.arc42.org/section-3/)).
- Make diagrams stand alone with clear titles, legends, element types, descriptions, and relationship labels ([C4 notation](https://c4model.com/diagrams/notation)).

### Quality-attribute tradeoff discipline

- Turn high-level qualities into scenarios and utility trees so tradeoffs can be analyzed instead of guessed ([arc42 section 10](https://docs.arc42.org/section-10/), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- Expect tradeoffs to be normal: Azure explicitly links every pillar to tradeoffs, and ATAM is built to reveal how quality goals interact rather than pretending all of them can be optimized independently ([Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).

### Operational and observability readiness

- Cloud architecture review should include operational excellence/operations, monitoring/observability, and safe deployment practices because AWS, Azure, and Google all treat operability as a first-class architectural dimension ([AWS Well-Architected home](https://aws.amazon.com/architecture/well-architected/), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

### Cloud architecture review standards

- Use well-architected reviews as **improvement conversations** and assessment tools, not as substitutes for detailed system-specific design review ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars)).
- Review architectures across security, reliability, performance, operations, cost, and sustainability where the selected cloud framework exposes those dimensions ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).

### Maintainability and evolutionary design

- Design for change, prefer simple structures, and decouple where it increases independent evolution and operational control ([Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
- Keep known risks and technical debt explicit instead of leaving them implicit in the architecture ([arc42 overview](https://arc42.org/overview)).

## Known ambiguities / scope notes

- The ISO page supplied in the task is a **withdrawn standard overview**, not the full standard text. It is still useful here for the abstracted architecture-description concepts it exposes, but this file treats it as conceptual rather than as a current normative standard ([ISO/IEC/IEEE 42010 overview](https://www.iso.org/standard/50508.html)).
- arc42 is a **documentation template and method**, not a complete architecture theory or evaluation method; pair it with scenario analysis and formal review methods when tradeoffs matter heavily ([arc42 overview](https://arc42.org/overview), [SEI ATAM collection](https://www.sei.cmu.edu/library/architecture-tradeoff-analysis-method-collection/)).
- C4 is a **visualization model**, not a full architecture process. It helps communicate static structure and related supporting views, but it does not replace decision records, quality scenarios, or evaluation methods ([C4 model home](https://c4model.com/), [C4 diagrams](https://c4model.com/diagrams)).
- AWS, Azure, and Google Cloud frameworks are all **cloud-provider-specific** perspectives. They are strong for operational architecture review, but they should not be mistaken for a complete vendor-neutral architecture-description method ([AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html), [Azure Well-Architected pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars), [Google Cloud Well-Architected Framework](https://cloud.google.com/architecture/framework)).
