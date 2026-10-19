//! The repository's `kingu.yaml`: why it does not parse, and what was ignored (agent/kingu_yaml.rs).

crate::i18n::messages! {
  pub enum KinguYamlMsg {
    TooLarge {
      en: "larger than {kb} KB",
      th: "ใหญ่เกิน {kb} KB",
    },
    AtLine {
      en: "line {line}: {detail}",
      th: "บรรทัด {line}: {detail}",
    },
    OneDocument {
      en: "only one YAML document is allowed",
      th: "มีเอกสาร YAML ได้เพียงเอกสารเดียว",
    },
    NoAliases {
      en: "aliases are not supported",
      th: "ไม่รองรับ alias",
    },
    NoAnchors {
      en: "anchors are not supported",
      th: "ไม่รองรับ anchor",
    },
    NoTags {
      en: "tags are not supported",
      th: "ไม่รองรับ tag",
    },
    TooDeep {
      en: "nested too deeply",
      th: "ซ้อนกันลึกเกินไป",
    },
    PlainKeys {
      en: "keys must be plain strings",
      th: "key ต้องเป็นข้อความธรรมดา",
    },
    Unbalanced {
      en: "unbalanced document",
      th: "โครงสร้างเอกสารเปิดปิดไม่ครบ",
    },
    TooManyValues {
      en: "too many values",
      th: "มีค่ามากเกินไป",
    },
    DuplicateKey {
      en: "duplicate key `{key}`",
      th: "key `{key}` ซ้ำ",
    },
    TopLevelMapping {
      en: "the top level must be a mapping",
      th: "ระดับบนสุดต้องเป็น mapping",
    },
    // Warnings: the field is ignored, the rest of the file still applies.
    UnknownKey {
      en: "unknown key `{key}`, ignored",
      th: "ไม่รู้จัก key `{key}` จึงข้ามไป",
    },
    ExpectedMapping {
      en: "{field}: expected a mapping, ignored",
      th: "{field}: ต้องเป็น mapping จึงข้ามไป",
    },
    ExpectedSequence {
      en: "{field}: expected a sequence, ignored",
      th: "{field}: ต้องเป็นรายการ (sequence) จึงข้ามไป",
    },
    ExpectedString {
      en: "{field}: expected a string, ignored",
      th: "{field}: ต้องเป็นข้อความ จึงข้ามไป",
    },
    FieldTooLong {
      en: "{field}: longer than {kb} KB, ignored",
      th: "{field}: ยาวเกิน {kb} KB จึงข้ามไป",
    },
    BadStartupPolicy {
      en: "setupAgentStartupPolicy: expected start-immediately or wait-for-setup, ignored",
      th: "setupAgentStartupPolicy: ต้องเป็น start-immediately หรือ wait-for-setup จึงข้ามไป",
    },
    TooManyEntries {
      en: "{field}: more than {max} entries, ignored",
      th: "{field}: มีเกิน {max} รายการ จึงข้ามไป",
    },
    BadColor {
      en: "{field}: expected #rgb or #rrggbb, ignored",
      th: "{field}: ต้องเป็น #rgb หรือ #rrggbb จึงข้ามไป",
    },
    NoEnvironments {
      en: "environmentRecipes: needs on-demand environments, which Kingu does not have yet; ignored",
      th: "environmentRecipes: ต้องใช้ environment แบบเรียกใช้ตามต้องการ ซึ่ง Kingu ยังไม่มี จึงข้ามไป",
    },
    UnsafePath {
      en: "worktree.sharedDirectories: `{path}` is not a safe repo-relative path, ignored",
      th: "worktree.sharedDirectories: `{path}` ไม่ใช่ path ภายใน repository ที่ปลอดภัย จึงข้ามไป",
    },
    FirstEntriesOnly {
      en: "{field}: only the first {max} entries are used",
      th: "{field}: ใช้แค่ {max} รายการแรก",
    },
  }
}
