import { describe, test, expect } from "bun:test"
import {
  detectOracleInversion,
  extractIssueExpectations,
  extractIssueThresholds,
  type IssueExpectation,
} from "../../src/session/issue-expectations"

describe("extractIssueExpectations", () => {
  test("12039-shaped: quoted-identifier spacing bug — expected and actual both extracted with correct kinds", () => {
    const issueText = [
      "The generated ORDER BY clause is missing a space before the direction keyword.",
      'Expected output contains the ordering `"name" DESC` with a space before DESC.',
      'Actual output produces `"name"DESC` with no space, which is the bug.',
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    const expected = literals.find((l) => l.value === '"name" DESC')
    const actual = literals.find((l) => l.value === '"name"DESC')
    expect(expected?.kind).toBe("expected")
    expect(actual?.kind).toBe("actual")
  })

  test("11790-shaped: typed-integer maxlength expectation extracted", () => {
    const issueText =
      "Expected: the maxlength attribute should be the typed integer `254`, not the string 254 rendered as text."

    const { literals } = extractIssueExpectations(issueText)

    const literal = literals.find((l) => l.value === "254")
    expect(literal).toBeDefined()
    expect(literal?.kind).toBe("expected")
    expect(literal?.source).toContain("maxlength")
  })

  test("11815-shaped: desired vs current enum serialization extracted with correct kinds", () => {
    const issueText = [
      "Expected serialization is `TextEnum['A']` for the enum field.",
      "Actual serialization returns `TextEnum('a-value')` instead.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    const expected = literals.find((l) => l.value === "TextEnum['A']")
    const actual = literals.find((l) => l.value === "TextEnum('a-value')")
    expect(expected?.kind).toBe("expected")
    expect(actual?.kind).toBe("actual")
  })

  test("noisy issue with no expected/actual markers returns empty", () => {
    const issueText = [
      "This is a really confusing issue with the 'thing' behavior.",
      "I tried several approaches and nothing seems to work as I'd hoped.",
      "Can someone help me figure out what is happening with the 'widget'?",
      "I read through the forums but could not find anything useful there.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals).toEqual([])
  })

  test("caps extraction at 8 literals even with 20 candidates", () => {
    const lines: string[] = []
    for (let i = 1; i <= 20; i++) {
      lines.push(`Expected: candidate value should be \`literal_${i}\` in this test case.`)
    }
    const issueText = lines.join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBe(8)
  })

  test("empty issue text returns empty and never throws", () => {
    expect(extractIssueExpectations("")).toEqual({ literals: [] })
  })
})

describe("detectOracleInversion", () => {
  const literals: IssueExpectation[] = [
    { value: "TextEnum['A']", kind: "expected", source: "serialization should be `TextEnum['A']`" },
    { value: "TextEnum('a-value')", kind: "actual", source: "currently got `TextEnum('a-value')`" },
  ]

  test("11815-shaped inversion: produced side carries the issue-desired value, assertion expects the buggy one", () => {
    const redTail = [
      "FAIL: test_serialize_enum (migrations.test_writer.WriterTests)",
      "Traceback (most recent call last):",
      '  File "tests/migrations/test_writer.py", line 283, in test_serialize_enum',
      "AssertionError: \"migrations.test_writer.TextEnum['A']\" != \"migrations.test_writer.TextEnum('a-value')\"",
    ].join("\n")
    const verdict = detectOracleInversion(redTail, literals)
    expect(verdict.inverted).toBe(true)
    expect(verdict.desiredLiteral).toBe("TextEnum['A']")
    expect(verdict.buggyLiteral).toBe("TextEnum('a-value')")
  })

  test("normal red (gold-aligned test, incomplete fix): buggy value first — NOT inversion", () => {
    const redTail = [
      "AssertionError: \"migrations.test_writer.TextEnum('a-value')\" != \"migrations.test_writer.TextEnum['A']\"",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("unittest long-string diff form: `-` produced line first still detects inversion", () => {
    const redTail = [
      "AssertionError: strings differ:",
      "- migrations.test_writer.TextEnum['A']",
      "+ migrations.test_writer.TextEnum('a-value')",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(true)
  })

  test("crash trace (no comparison failure) never qualifies", () => {
    const redTail = [
      "Traceback (most recent call last):",
      '  File "repro_issue.py", line 4, in <module>',
      "TypeError: __init__() missing 1 required positional argument",
    ].join("\n")
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("one side missing from the tail → conservative false", () => {
    const redTail = "AssertionError: \"migrations.test_writer.TextEnum['A']\" != \"something else entirely\""
    expect(detectOracleInversion(redTail, literals).inverted).toBe(false)
  })

  test("no expected/actual literal pair extracted → false; undefined tail → false", () => {
    const onlyExpected: IssueExpectation[] = [literals[0]]
    expect(detectOracleInversion("AssertionError: x != y", onlyExpected).inverted).toBe(false)
    expect(detectOracleInversion(undefined, literals).inverted).toBe(false)
  })
})

describe("detectOracleInversion — FORM-CLASS rung (11815 promoted-pin form)", () => {
  // The issue extractor stores a single expected-kind literal here (no
  // "actual"-kind counterpart) — the live 11815 shape where the literal rung
  // is structurally blind and only the form rung can fire.
  const promotedLiterals: IssueExpectation[] = [
    {
      value: "('status', models.CharField(default=Status['GOOD'], max_length=128))",
      kind: "expected",
      source: "It should be: ('status', models.CharField(default=Status['GOOD'], max_length=128))",
    },
  ]
  const redTail = [
    "FAIL: test_serialize_enum (migrations.test_writer.WriterTests)",
    "Traceback (most recent call last):",
    '  File "tests/migrations/test_writer.py", line 283, in test_serialize_enum',
    "AssertionError: Tuples differ: (\"TextEnum['A']\", 1) != (\"migrations.test_writer.TextEnum('a-value')\", 1)",
    "",
    "First differing element 0:",
    "\"TextEnum['A']\"",
    "\"migrations.test_writer.TextEnum('a-value')\"",
    "",
    "- (\"TextEnum['A']\", 1)",
    "+ (\"migrations.test_writer.TextEnum('a-value')\", 1)",
  ].join("\n")

  test("promotedPin:true, no literal-rung actual pair — subscript-vs-call same identifier fires as inversion", () => {
    const verdict = detectOracleInversion(redTail, promotedLiterals, { promotedPin: true })
    expect(verdict.inverted).toBe(true)
    expect(verdict.desiredLiteral).toBe("TextEnum['A']")
    expect(verdict.buggyLiteral).toContain("TextEnum('a-value')")
  })

  test("opts absent — never fires even with the identical inverting shape", () => {
    expect(detectOracleInversion(redTail, promotedLiterals).inverted).toBe(false)
  })

  test("promotedPin:false — never fires (an agent's own repro legitimately expects the desired form pre-fix)", () => {
    expect(detectOracleInversion(redTail, promotedLiterals, { promotedPin: false }).inverted).toBe(false)
  })

  test("no subscript-form literal among expected literals — rung never applies", () => {
    const literals: IssueExpectation[] = [
      { value: "the migration should use the enum name, not its value", kind: "expected", source: "..." },
    ]
    expect(detectOracleInversion(redTail, literals, { promotedPin: true }).inverted).toBe(false)
  })

  test("subscript and call forms on DIFFERENT identifiers — no match", () => {
    const differentIdentTail = "AssertionError: (\"TextEnum['A']\", 1) != (\"OtherEnum('v')\", 1)"
    expect(detectOracleInversion(differentIdentTail, promotedLiterals, { promotedPin: true }).inverted).toBe(false)
  })

  test("only one of the two forms present in the region — no match", () => {
    const onlySubscriptTail = "AssertionError: expected \"TextEnum['A']\" but got something else"
    expect(detectOracleInversion(onlySubscriptTail, promotedLiterals, { promotedPin: true }).inverted).toBe(false)
  })

  test("mirror ordering: call form BEFORE subscript form — code still PRODUCES the value form, test expects the desired form; never inversion", () => {
    // Produced-side-prints-first (rung-1's own heuristic): call-form first
    // means the fix is wrong and the test agrees with the issue — firing here
    // would tell the agent to keep a broken fix.
    const mirrorTail = [
      "AssertionError: Tuples differ: (\"migrations.test_writer.TextEnum('a-value')\", 1) != (\"TextEnum['A']\", 1)",
      "",
      "First differing element 0:",
      "\"migrations.test_writer.TextEnum('a-value')\"",
      "\"TextEnum['A']\"",
    ].join("\n")
    expect(detectOracleInversion(mirrorTail, promotedLiterals, { promotedPin: true }).inverted).toBe(false)
  })

  test("no comparison-failure line (plain traceback/ImportError) — no match", () => {
    const crashTail = [
      "Traceback (most recent call last):",
      '  File "migrations/writer.py", line 12, in <module>',
      "ImportError: cannot import name 'TextEnum' from 'migrations.test_writer'",
    ].join("\n")
    expect(detectOracleInversion(crashTail, promotedLiterals, { promotedPin: true }).inverted).toBe(false)
  })

  test("ordering: literal rung wins first — identical result with and without promotedPin:true", () => {
    const literalRungLiterals: IssueExpectation[] = [
      { value: "TextEnum['A']", kind: "expected", source: "serialization should be `TextEnum['A']`" },
      { value: "TextEnum('a-value')", kind: "actual", source: "currently got `TextEnum('a-value')`" },
    ]
    const literalRungRedTail = [
      "AssertionError: \"migrations.test_writer.TextEnum['A']\" != \"migrations.test_writer.TextEnum('a-value')\"",
    ].join("\n")

    const withoutOpts = detectOracleInversion(literalRungRedTail, literalRungLiterals)
    const withPromotedPin = detectOracleInversion(literalRungRedTail, literalRungLiterals, { promotedPin: true })
    expect(withoutOpts).toEqual(withPromotedPin)
    expect(withoutOpts.inverted).toBe(true)
  })
})

// Round-F strict-sweep forensics: the ten real django-issue prompts from the
// Mini-10 ladder, embedded verbatim (trimmed to the relevant excerpt) so the
// extractors are proven against real prose, not hand-shaped synthetic text.
// 12039 and 11848 were the two live failures the gap closes; the other eight
// are the false-fire audit protecting the instances already passing.
describe("extractIssueExpectations / extractIssueThresholds — round-F real issue-text fixtures", () => {
  test("11790 (typed-integer maxlength regression) — no marker language in the real prompt, extracts nothing", () => {
    const issueText = [
      "AuthenticationForm's username field doesn't set maxlength HTML attribute.",
      "AuthenticationForm's username field doesn't render with maxlength HTML attribute anymore.",
      "Regression introduced in #27515 and 5ceaf14686ce626404afb6a5fbd3d8286410bf13.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(2)
    expect(literals).toEqual([])
  })

  test("11815 (migration enum value vs name) — 'It should be:' worked example captures the corrected line", () => {
    const issueText = [
      "Migrations uses value of enum object instead of its name.",
      "When using Enum object as a default value for a CharField, the generated migration file uses the value of the Enum object instead of the its name. This causes a problem when using Django translation on the value of the Enum object.",
      "In the generated migration file, the code will be:",
      "('status', models.CharField(default=Status('Good'), max_length=128))",
      "After the translation, 'Good' will be translated to another word and it will not be part of the Status Enum class any more, so the migration file will raise the error on the previous line:",
      "ValueError: 'Good' is not a valid Status",
      "Shouldn't the code generated by the migration uses the name of the Status Enum 'GOOD', not the value of it, since it is changeable?",
      "It should be:",
      "('status', models.CharField(default=Status['GOOD'], max_length=128))",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([
      {
        value: "('status', models.CharField(default=Status['GOOD'], max_length=128))",
        kind: "expected",
        source: "It should be: ('status', models.CharField(default=Status['GOOD'], max_length=128))",
      },
    ])
  })

  test("11848 (RFC 7231 two-digit-year rule) — extractIssueThresholds finds the stated 50-year boundary", () => {
    const issueText = [
      "RFC 850 does not mention this, but in RFC 7231 (and there's something similar in RFC 2822), there's the following quote:",
      "Recipients of a timestamp value in rfc850-date format, which uses a",
      "two-digit year, MUST interpret a timestamp that appears to be more",
      "than 50 years in the future as representing the most recent year in",
      "the past that had the same last two digits.",
      "Current logic is hard coded to consider 0-69 to be in 2000-2069, and 70-99 to be 1970-1999, instead of comparing versus the current year.",
    ].join("\n")

    const thresholds = extractIssueThresholds(issueText)

    expect(thresholds).toEqual([
      {
        value: 50,
        quote:
          "Recipients of a timestamp value in rfc850-date format, which uses a two-digit year, MUST interpret a timestamp that appears to be more than 50 years in the future as representing the most recent year ",
      },
    ])
    // The bug report never states a threshold itself — no false extraction from the prompt text.
    expect(extractIssueExpectations(issueText).literals).toEqual([])
  })

  test("11880 (deepcopy shares error_messages dict) — false-fire audit: pre-existing 'sealed' quote, no new noise, ≤4 items", () => {
    const issueText = [
      "Form Field's __deepcopy__ does not (deep)copy the error messages.",
      "The __deepcopy__ method defined for the formfields performs a shallow copy of self and does not include additional treatment for the error_messages dictionary. As a result, all copies of the same field share the same dictionary and any modification of either the dictionary or the error message itself for one formfield is immediately reflected on all other formfiels.",
      'This is relevant for Forms and ModelForms that modify the error messages of their fields dynamically: while each instance of the specific form (e.g., ProfileForm) is expected to have a set of fields "sealed" away from other instances of the same ProfileForm, in fact all these instances share the same error messages, resulting in incorrectly raised errors.',
      "Confirmed for versions of Django going back to 1.11.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([
      {
        value: "sealed",
        kind: "expected",
        source:
          "This is relevant for Forms and ModelForms that modify the error messages of their fields dynamically: while each instance of the specific form (e.g., ProfileFor",
      },
    ])
    expect(extractIssueThresholds(issueText)).toEqual([])
  })

  test("11885 (combine fast delete queries) — false-fire audit: raw DELETE/SQL prose never mistaken for a worked example", () => {
    const issueText = [
      "Combine fast delete queries",
      "When emulating ON DELETE CASCADE via on_delete=models.CASCADE the deletion.Collector will try to perform fast queries which are DELETE FROM table WHERE table.pk IN .... There's a few conditions required for this fast path to be taken but when this happens the collection logic should combine such queries by table to reduce the number of roundtrips to the database.",
      "For example, given the following models",
      "class Person(models.Model):",
      "\tfriends = models.ManyToManyField('self')",
      "class User(models.Model):",
      "\tpass",
      "class Entry(models.Model):",
      "\tcreated_by = models.ForeignKey(User)",
      "\tupdated_by = models.ForeignKey(User)",
      "Issuing a person.delete() or user.delete() will result in 3 queries of the form",
      "DELETE FROM person_friends WHERE from_id = :id",
      "DELETE FROM person_friends WHERE to_id = :id",
      "DELETE FROM person WHERE id = :id",
      "DELETE FROM entry WHERE created_by_id = :id",
      "DELETE FROM entry WHERE updated_by = :id",
      "DELETRE FROM user WHERE id = :id",
      "But both queries (or N queries depending on the number of foreign relationships) can be combined into a single one by using OR",
      "DELETE FROM person_friends WHERE from_id = :id OR to_id = :id",
      "DELETE FROM person WHERE id = :id",
      "DELETE FROM entry WHERE created_by_id = :id OR updated_by = :id",
      "DELETE FROM user WHERE id = :id",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([])
    expect(extractIssueThresholds(issueText)).toEqual([])
  })

  test("11951 (TextChoices differing type) — false-fire audit: no fenced code block means the assertion/diff lines stay unextracted, ≤4 items", () => {
    const issueText = [
      "If we create an instance of a model having a CharField or IntegerField with the keyword choices pointing to IntegerChoices or TextChoices, the value returned by the getter of the field will be of the same type as the one created by enum.Enum (enum value).",
      'self.assertEqual(str(my_object.my_str_value), "first")',
      "AssertionError: 'MyChoice.FIRST_CHOICE' != 'first'",
      "We notice when invoking __str__(...) we don't actually get the value property of the enum value which can lead to some unexpected issues, especially when communicating to an external API with a freshly created instance that will send MyEnum.MyValue, and the one that was retrieved would send my_value.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([])
    expect(extractIssueThresholds(issueText)).toEqual([])
  })

  test("11964 (cannot override get_FOO_display) — false-fire audit: pre-existing 'returns X or Y' triple, ≤4 items", () => {
    const issueText = [
      "Cannot override get_FOO_display() in Django 2.2+.",
      "I cannot override the get_FIELD_display function on models since version 2.2. It works in version 2.1.",
      "return self.get_foo_bar_display() # This returns 'foo' or 'bar' in 2.2, but 'something' in 2.1",
      "What I expect is that I should be able to override this function.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([
      {
        value: "foo",
        kind: "actual",
        source: "return self.get_foo_bar_display() # This returns 'foo' or 'bar' in 2.2, but 'something' in 2.1",
      },
      {
        value: "bar",
        kind: "actual",
        source: "return self.get_foo_bar_display() # This returns 'foo' or 'bar' in 2.2, but 'something' in 2.1",
      },
      {
        value: "something",
        kind: "actual",
        source: "return self.get_foo_bar_display() # This returns 'foo' or 'bar' in 2.2, but 'something' in 2.1",
      },
    ])
    // "What I expect is that I should be able to..." has no colon after "should be" — the
    // worked-example block marker requires one, so it never fires here.
    expect(extractIssueThresholds(issueText)).toEqual([])
  })

  test("11999 (resolve_lookup_value tuple coercion) — false-fire audit: 'expected ... should match' has no colon, extracts nothing", () => {
    const issueText = [
      "Query.resolve_lookup_value coerces value of type list to tuple",
      "Changes introduced in #30687 cause an input value list to be coerced to tuple breaking exact value queries. This affects ORM field types that are dependent on matching input types such as PickledField.",
      "The expected iterable return type should match input iterable type.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([])
    expect(extractIssueThresholds(issueText)).toEqual([])
  })

  test("12039 (CREATE INDEX quoted-identifier whitespace) — extracts the discriminating expected/actual DESC statement pair", () => {
    const issueText = [
      "Creating an index through:",
      "Will generate the valid but not so pretty CREATE INDEX statement:",
      'CREATE INDEX "idx" ON "schema_author" ("name"DESC)',
      "The following would be expected:",
      'CREATE INDEX "idx" ON "schema_author" ("name" DESC)',
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    const expected = literals.find((l) => l.value === 'CREATE INDEX "idx" ON "schema_author" ("name" DESC)')
    const actual = literals.find((l) => l.value === 'CREATE INDEX "idx" ON "schema_author" ("name"DESC)')
    expect(expected?.kind).toBe("expected")
    expect(actual?.kind).toBe("actual")
    expect(literals).toEqual([
      {
        value: 'CREATE INDEX "idx" ON "schema_author" ("name"DESC)',
        kind: "actual",
        source: 'Will generate the valid but not so pretty CREATE INDEX statement: CREATE INDEX "idx" ON "schema_author" ("name"DESC)',
      },
      {
        value: 'CREATE INDEX "idx" ON "schema_author" ("name" DESC)',
        kind: "expected",
        source: 'The following would be expected: CREATE INDEX "idx" ON "schema_author" ("name" DESC)',
      },
    ])
  })

  test("12050 (bulk_create batch_size override) — false-fire audit: 'picks the minimum of two:' colon never grabs the URL/formula lines", () => {
    const issueText = [
      "bulk_create batch_size param overrides the compatible batch size calculation",
      "batch_size param overrides compatible batch size calculation. This looks like a bug as bulk_update properly picks the minimum of two:",
      "I suggest using similar",
      "batch_size = min(batch_size, max_batch_size) if batch_size else max_batch_size",
      "logic in bulk_create as well. I am happy to open a PR for it.",
    ].join("\n")

    const { literals } = extractIssueExpectations(issueText)

    expect(literals.length).toBeLessThanOrEqual(4)
    expect(literals).toEqual([])
    expect(extractIssueThresholds(issueText)).toEqual([])
  })
})
