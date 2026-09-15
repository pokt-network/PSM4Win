---
title: Services
description: What a service is on Pocket Network, how services relate to suppliers, applications, and gateways, and how anyone can register and deploy one.
sidebar:
  order: 1
---

A **service** is any API that can be reached through Pocket Network. Blockchain RPC endpoints are the best-known examples, but a service can be anything that answers an HTTP request: an LLM inference endpoint, an embeddings model, a data aggregator, a rendering API, an MCP server. Pocket does not care what the service does. It cares that a request was signed by a paying application, that a staked supplier answered it, and that the supplier can prove it did.

Every service registered on the network is listed at [explorer.pocket.network/services](https://explorer.pocket.network/services).

## Services Are Permissionless

Anyone can register a service, and anyone can supply one. There is no allowlist, no review, and no foundation approval step. Registering costs a one-time fee, supplying requires a stake, and both are governed by on-chain parameters rather than by people. A service with one supplier and a service with two hundred are the same kind of object on-chain.

The consequence is that quality is decided by the market, not by the protocol. Gateways score suppliers on the responses they return, applications choose which gateways and services to use, and a service that is badly specified or badly served simply attracts no traffic. The guides in this section exist so a service you register is specified and served well from the first relay.

## How the Pieces Fit Together

Five things are involved in every relay. Three of them are on-chain records and two are running software.

| Piece | What it is | Who controls it |
|---|---|---|
| **Service** | An on-chain record: a service ID, a human-readable name, a price in compute units per relay, an owner address, and an optional metadata card describing the API. Nothing runs here. | The service owner, who registered it and is the only account that can update it. |
| **Service backend** | The running software that actually answers requests. A web server, a model server, a node. It knows nothing about Pocket. | Each supplier runs their own. |
| **RelayMiner** | The software that sits in front of a backend, receives signed relay requests from the network, forwards them to the backend as plain HTTP, signs the responses, and submits claims and proofs on-chain so the supplier gets paid. | Each supplier runs their own. |
| **Supplier stake** | An on-chain record that says "this operator serves service X at this public URL." Requires a stake in POKT. A supplier can serve many services, and a service can have many suppliers. | The supplier's owner and operator accounts. |
| **Application stake** | An on-chain record that says "this account pays for relays to service X." Requires a stake in POKT that is drawn down as relays settle. | The application's account. |
| **Gateway** | Optional running software and an on-chain stake. A gateway holds application keys, signs relays on behalf of applications, selects suppliers, retries failures, and scores supplier quality. Most end users reach services through a gateway rather than signing relays themselves. | The gateway operator. |

The flow of a single relay:

```
client ──► gateway (or a self-signing application)
               │  finds the current session for (application, service)
               │  picks one of the session's suppliers
               │  signs the request with the application's key
               ▼
        supplier's RelayMiner ──► service backend
               │  verifies the signature and session
               │  forwards the request as plain HTTP
               │  signs the backend's response
               │  records the relay for its claim
               ▼
        gateway ──► client
```

Sessions are the unit of accounting. Every 20 blocks the protocol deterministically assigns a set of suppliers to each (application, service) pair. The RelayMiner batches the relays it served during a session into a claim, submits it, and is paid from the application's stake when the claim settles. The service owner receives a share of that settlement too, which is the economic reason to register a service well rather than just to register it.

## Two Roles, Usually One Person at First

Registering a service and supplying a service are separate acts with separate on-chain records.

- **The service owner** registers the service ID, sets its price, and publishes the metadata card that tells everyone else how to call it and how to serve it. This is a one-time act plus occasional updates. The owner does not need to run anything.
- **A supplier** stakes on the service and runs a backend plus a RelayMiner. Suppliers are what make a service reachable. Without at least one supplier, a registered service exists on-chain and serves nothing.

When you bring a new service to the network you will almost always do both: register the service, then become its first supplier. Once the service has traffic, other operators can stake on it independently by reading the card you published.

## What Makes a Service Work Well on Pocket

The protocol enforces very little about the shape of a service. Gateways enforce more, because they grade every response to decide which suppliers to trust. A service that returns responses gateways cannot grade will see its suppliers penalized for answering correctly.

The rules that matter are covered in [Deploy a Service](/services/deploy), but the short version is:

- Every response is a JSON object. HTML, CSV, images, or any other non-JSON output travels as a string field inside that object.
- All inputs arrive in the request body. Request headers and the caller's content type do not reach the backend.
- Client errors are 4xx with a JSON body. Server errors are 5xx and are never paid.
- The metadata card describes the API accurately, including health checks a supplier can run before staking.

## In This Section

- [Register a Service](/services/register): create the on-chain service record, choose its price, and publish its metadata card.
- [Deploy a Service](/services/deploy): build a backend that works well behind a RelayMiner, stake a supplier, run the RelayMiner, and test end to end.

## Related Pages

- [Supplier Staking](/node-operators/supplier-staking)
- [RelayMiner Setup](/node-operators/relayminer-setup)
- [HA RelayMiner](/node-operators/ha-relayminer)
- [Application Staking](/developers/application-staking)
- [Gateways](/gateways/)
- [Networks](/get-started/networks)
