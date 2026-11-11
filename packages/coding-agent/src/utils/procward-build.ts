// Artifact-owned process ownership capability; source checkouts default to enabled.
declare const PI_PROCWARD_INCLUDED: boolean;

export const procwardIncluded: boolean = typeof PI_PROCWARD_INCLUDED === "undefined" ? true : PI_PROCWARD_INCLUDED;
