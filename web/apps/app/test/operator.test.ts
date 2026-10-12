import { describe, expect, it } from "vitest";
import { defaultOperator } from "../src/data/operator.ts";
import { DEMO, createFakeServices } from "../src/services/fake.ts";
import { SessionStore, sessionActions } from "../src/session.tsx";

const ana = { id: "m-ana", name: "Ana" };
const bia = { id: "m-bia", name: "Bia Marcador" };
const teste = { id: "m-teste", name: "Teste" };

describe("default operator", () => {
  it("never depends on the order the members came back in", () => {
    // The order follows opaque record ids; the account's own member wins either way.
    expect(defaultOperator([bia, teste], "Teste Local")).toBe(teste.id);
    expect(defaultOperator([teste, bia], "Teste Local")).toBe(teste.id);
    // Without a match, the first by name (Portuguese order, ignoring case and accents).
    expect(defaultOperator([teste, bia, { id: "m-alvaro", name: "Álvaro" }], "Carla")).toBe("m-alvaro");
    expect(defaultOperator([teste, bia], null)).toBe(bia.id);
  });

  it("matches the account's first name ignoring case and accents, but not when it is ambiguous", () => {
    expect(defaultOperator([bia, { id: "m-joao", name: "joão" }], "João Silva")).toBe("m-joao");
    const twoAnas = [teste, ana, { id: "m-ana-2", name: "ana" }];
    expect(defaultOperator(twoAnas, "Ana Souza")).toBe(ana.id); // ambiguous: falls back to the order by name
  });

  it("keeps a choice made earlier while that member still exists", () => {
    expect(defaultOperator([bia, teste], "Teste Local", bia.id)).toBe(bia.id);
    expect(defaultOperator([bia, teste], "Teste Local", "m-removed")).toBe(teste.id);
  });

  it("is empty without members", () => {
    expect(defaultOperator([], "Ana")).toBeNull();
  });
});

describe("operator in the session", () => {
  it("remembers the choice per project while the tab lives, and starts over after signing out", async () => {
    const services = createFakeServices({ seed: true });
    const store = new SessionStore();
    const actions = sessionActions(services, store);
    await actions.signIn(DEMO.email, DEMO.password);
    const project = services.demoProjectId!;
    await actions.openProject(project, DEMO.projectPassword);
    const named = (name: string) => store.get().open!.members.find((m) => m.name === name)!.id;
    expect(store.get().operatorId).toBe(named("Ana")); // the account is Ana Souza
    actions.setOperator(named("Bruno"));
    await actions.closeProject();
    await actions.openProject(project, DEMO.projectPassword);
    expect(store.get().operatorId).toBe(named("Bruno"));
    await actions.lock();
    await actions.unlock(DEMO.projectPassword);
    expect(store.get().operatorId).toBe(named("Bruno"));
    await actions.signOut();
    await actions.signIn(DEMO.email, DEMO.password);
    await actions.openProject(project, DEMO.projectPassword);
    expect(store.get().operatorId).toBe(named("Ana"));
  });
});
