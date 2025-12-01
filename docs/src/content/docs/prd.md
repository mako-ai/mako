---
title: Product Requirements Document (PRD)
description: Product requirements for Mako
---

## Document Information

- **Product Name:** Mako
- **Version:** 0.1
- **Date:** 2025-10-07
- **Author:** Joan Rodriguez
- **Status:** Draft

---

## Executive Summary

Mako aims to be Cursor for Data. It is a AI powered data platform that allows you build a data warehouse by connecting to your existing data bases and third party data sources, then rely on AI to write queries and analyse your data. It is designed to be used by semi-technical users who are empowered by AI to build their own data solutions. It is an open source project that is also deployed as a multi-tenant SaaS product.

---

## Problem Statement

### Background

Let's say that a SaaS company wants to build a unified view of their customers in order to make better decisions.

### Problem Description

- Data live in different databases and data sources:
  -- Payment data lives in Stripe
  -- Customer data lives in the CRM (Salesforce, Hubspot, Close.com)
  -- Product data lives in the SaaS's own databse
  -- Analytics data lives in 3rd party analytics tools (GA4, PostHog, Mixpanel, etc.)
- Because the data lives in different places, it is not possible to join the data together to build a single view of the customer.
- For the data that lives in a third party database, it is not possible to write queries to analyse the data.
- Even after the data is joined together in a datawarehouse, the users still needs to access it with a SQL client or a BI tool before they can start analysing the data.
- Even after they have connected to their data, they still need to write queries to analyse the data.
- Even if they can copy/paste between ChatGPT and a SQL client, an external LLM doesn't have access to the data schema, the actual data or the data warehouse. It can't test the queries or the results.
- Even once the company has a functioning datawarehouse, a set of nice queries, they still need to be able to share them with the rest of the company, and keep track of changes.

## Solution

Mako solves all of these challenges by stacking the following components:

- An ETL pipeline that allows to connect to a variety of existing data bases and third party apis and sync the data to a data warehouse.
- A database client that allows to connect to every type of database and run queries on the data.
- An AI assistant with access to the data warehouse with tools like inspect_schema and execute_query that can help the user write queries and analyse the data.
- A multi-tenant SaaS product that allows to customize the prompt and share your queries with the rest of the company.

### Impact

By getting all of the data in a single place and making it accessible to AI, the user can start to build a unified view of their customers, products, sales, marketing, etc. and get answers to questions like:

- Who are my best customers?
- Which customers are at risk of churning?
- What products are most popular?
- Who are my top salespeople?

The goal is not only to make it possible to answer these questions, but also to make the process of building these solutions as easy as possible. Getting these answers should be 100x faster thanks to AI and automation.

---

## Goals and Objectives

### Primary Goals

1. Build a data warehouse that allows to connect to a variety of existing data bases and third party apis and sync the data to a data warehouse.
2. Build a database client that allows to connect to every type of database and run queries on the data.
3. Build an AI assistant with access to the data warehouse with tools like inspect_schema and execute_query that can help the user write queries and analyse the data.
4. Build a multi-tenant SaaS product that allows to customize the prompt and share your queries with the rest of the company.
5. Publish the product as an open source project that can be used by anyone easily.

### Success Metrics

- **Metric 1:** Companies using Mako to build a data warehouse and use AI to analyse their data.
- **Metric 2:** The product is used by 1000 companies.
- **Metric 3:** The project has 1000 stars on GitHub.

### Non-Goals

- We will not build a data warehouse from scratch. We will use existing data warehouses like Snowflake, BigQuery, etc.

---

## User Personas

### Persona 1: The CEO

- **Role:** CEO
- **Goals:** Get answers to complex business questions.
- **Pain Points:** Every new question needs to be answered by a data analyst, which is time consuming and expensive.
- **Technical Proficiency:** Medium
- **Usage Context:** Every day to monitor the health of the business.

### Persona 2: The Data Analyst

- **Role:** Data Analyst
- **Goals:** Answer questions that involve large amoutns of data from different sources.
- **Pain Points:** Need to build a data warehouse, regularly update it and add new data sources, write new queries all the time, send results to the business users.
- **Technical Proficiency:** High
- **Usage Context:** Every day to answer questions that involve large amoutns of data from different sources.

### Persona 3: The Product Manager

- **Role:** Product Manager
- **Goals:** Steer the product in a direction that is aligned with the business goals.
- **Pain Points:** Can't access the data easily to make informed decisions.
- **Technical Proficiency:** Medium
- **Usage Context:** Anytime to make informed decisions.

---

## User Stories

### Epic 1:

- **User Story 1.1:** As a [persona], I want to [action] so that [benefit]

  - **Acceptance Criteria:**
    - [ ] Criteria 1
    - [ ] Criteria 2
    - [ ] Criteria 3

- **User Story 1.2:** As a [persona], I want to [action] so that [benefit]
  - **Acceptance Criteria:**
    - [ ] Criteria 1
    - [ ] Criteria 2

### Epic 2: [Epic Name]

[Continue with more epics and user stories]

---

## Functional Requirements

### Must Have (P0)

1. **[Feature Name]**

   - Description: [Detailed description]
   - User Impact: [How this affects users]
   - Technical Considerations: [Any technical notes]

2. **[Feature Name]**
   - Description: [Detailed description]
   - User Impact: [How this affects users]
   - Technical Considerations: [Any technical notes]

### Should Have (P1)

1. **[Feature Name]**
   - Description: [Detailed description]
   - User Impact: [How this affects users]
   - Technical Considerations: [Any technical notes]

### Nice to Have (P2)

1. **[Feature Name]**
   - Description: [Detailed description]
   - User Impact: [How this affects users]
   - Technical Considerations: [Any technical notes]

---

## Non-Functional Requirements

### Performance

- [Requirement 1: e.g., Page load time < 2 seconds]
- [Requirement 2: e.g., Support 10,000 concurrent users]

### Security

- [Requirement 1: e.g., All data encrypted at rest and in transit]
- [Requirement 2: e.g., RBAC implementation]

### Reliability

- [Requirement 1: e.g., 99.9% uptime SLA]
- [Requirement 2: e.g., Automated backups every 24 hours]

### Usability

- [Requirement 1: e.g., Mobile-responsive design]
- [Requirement 2: e.g., Accessibility compliance with WCAG 2.1 AA]

### Scalability

- [Requirement 1: e.g., Horizontal scaling capability]
- [Requirement 2: e.g., Support for multi-region deployment]

---

## Technical Architecture

### High-Level Architecture

[Describe the overall system architecture, major components, and how they interact]

### Technology Stack

- **Frontend:** [Technologies/frameworks]
- **Backend:** [Technologies/frameworks]
- **Database:** [Database systems]
- **Infrastructure:** [Cloud provider, containerization, etc.]
- **Third-party Services:** [External APIs, services]

### Data Model

[Describe key data entities and their relationships]

### API Design

[High-level API structure and key endpoints]

---

## User Interface

### Design Principles

1. [Principle 1]
2. [Principle 2]
3. [Principle 3]

### Key Screens/Flows

1. **[Screen/Flow Name]**

   - Purpose: [What this screen/flow accomplishes]
   - Key Elements: [Main UI components]
   - User Actions: [What users can do]

2. **[Screen/Flow Name]**
   - Purpose: [What this screen/flow accomplishes]
   - Key Elements: [Main UI components]
   - User Actions: [What users can do]

### Mockups/Wireframes

[Link to design files or embed images]

---

## Dependencies and Constraints

### Dependencies

- **Internal Dependencies:**
  - [System/team 1]
  - [System/team 2]
- **External Dependencies:**
  - [Third-party service 1]
  - [Third-party service 2]

### Constraints

- **Technical:** [e.g., Must use existing authentication system]
- **Business:** [e.g., Must launch before Q4]
- **Legal/Compliance:** [e.g., GDPR compliance required]
- **Resource:** [e.g., Limited to 3 developers]

---

## Risks and Mitigation

| Risk     | Probability     | Impact          | Mitigation Strategy |
| -------- | --------------- | --------------- | ------------------- |
| [Risk 1] | High/Medium/Low | High/Medium/Low | [How to address]    |
| [Risk 2] | High/Medium/Low | High/Medium/Low | [How to address]    |
| [Risk 3] | High/Medium/Low | High/Medium/Low | [How to address]    |

---

## Timeline and Milestones

### Phase 1: [Phase Name] (Estimated: X weeks)

- [ ] Milestone 1: [Description]
- [ ] Milestone 2: [Description]
- [ ] Milestone 3: [Description]

### Phase 2: [Phase Name] (Estimated: X weeks)

- [ ] Milestone 1: [Description]
- [ ] Milestone 2: [Description]

### Phase 3: [Phase Name] (Estimated: X weeks)

- [ ] Milestone 1: [Description]
- [ ] Milestone 2: [Description]

### Key Dates

- **Project Kickoff:** [Date]
- **Design Complete:** [Date]
- **Development Start:** [Date]
- **Beta Release:** [Date]
- **Production Release:** [Date]

---

## Testing Strategy

### Testing Approach

- **Unit Testing:** [Coverage goals and approach]
- **Integration Testing:** [Scope and approach]
- **User Acceptance Testing:** [Process and participants]
- **Performance Testing:** [Metrics and tools]

### Test Scenarios

[List key test scenarios that must be validated]

---

## Launch Plan

### Pre-Launch

- [ ] Feature freeze date: [Date]
- [ ] Security review complete
- [ ] Performance testing complete
- [ ] Documentation ready
- [ ] Support team trained

### Launch

- [ ] Gradual rollout plan
- [ ] Monitoring and alerting configured
- [ ] Rollback plan documented
- [ ] Communication plan executed

### Post-Launch

- [ ] Success metrics tracking
- [ ] User feedback collection
- [ ] Bug triage process
- [ ] Iteration planning

---

## Support and Maintenance

### Documentation

- User documentation location: [Link]
- Technical documentation location: [Link]
- API documentation location: [Link]

### Support Plan

- Support channels: [List channels]
- SLA commitments: [Response times]
- Escalation process: [How issues escalate]

### Maintenance

- Update frequency: [How often updates will be released]
- Deprecation policy: [How features will be deprecated]
- Backward compatibility: [Policy on breaking changes]

---

## Appendices

### Appendix A: Glossary

[Define key terms and acronyms used in this document]

### Appendix B: References

[List any reference documents, research, or competitive analysis]

### Appendix C: Meeting Notes

[Link to or summarize key meeting notes and decisions]

### Appendix D: Change Log

| Date   | Version | Changes       | Author |
| ------ | ------- | ------------- | ------ |
| [Date] | 1.0     | Initial draft | [Name] |

---

## Sign-off

| Role                 | Name   | Signature  | Date   |
| -------------------- | ------ | ---------- | ------ |
| Product Manager      | [Name] | **\_\_\_** | **\_** |
| Engineering Lead     | [Name] | **\_\_\_** | **\_** |
| Design Lead          | [Name] | **\_\_\_** | **\_** |
| QA Lead              | [Name] | **\_\_\_** | **\_** |
| Business Stakeholder | [Name] | **\_\_\_** | **\_** |
