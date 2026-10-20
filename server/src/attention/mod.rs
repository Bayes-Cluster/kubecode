//! What waits on the researcher (ADR 0232): one server projection, computed
//! on read from records that already exist, keyed by each decision's
//! identity so one decision appears once whichever records refer to it.
//! `collect` does the I/O; `project` is pure.

mod collect;
mod project;
#[cfg(test)]
mod tests;
mod types;

pub use collect::collect;
pub use project::{MAX_ITEMS, project};
pub use types::*;
