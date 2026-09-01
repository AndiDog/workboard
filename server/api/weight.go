package api

import (
	"fmt"
	"regexp"

	"andidog.de/workboard/server/proto"
)

// compiledWeightRule is a configured weight rule whose condition was validated once at startup, together with
// the compiled regular expression in case the condition uses one
type compiledWeightRule struct {
	rule  *proto.WeightRule
	regex *regexp.Regexp
}

// calculateCodeReviewWeight returns the weight which decides sorting and grouping in the UI. Conditions can use
// configuration-dependent fields, so those must be filled before calling this.
func calculateCodeReviewWeight(codeReview *proto.CodeReview, weightRules []compiledWeightRule) int32 {
	if codeReview.ManualWeightOverride != nil {
		return *codeReview.ManualWeightOverride
	}

	var weight int32
	for _, weightRule := range weightRules {
		condition := weightRule.rule.GetCondition()

		// Exactly one condition is set, as ensured by `compileWeightRules`
		conditionHolds := false
		switch {
		case condition.AuthorContainsRegex != "":
			conditionHolds = weightRule.regex.MatchString(codeReview.GetRenderOnlyFields().GetAuthorName())
		case condition.CodeReviewTitleContainsRegex != "":
			conditionHolds = weightRule.regex.MatchString(codeReview.GetGithubFields().GetTitle())
		case condition.GithubPrPipelineStatusRegex != "":
			conditionHolds = weightRule.regex.MatchString(codeReview.GetGithubFields().GetStatusCheckRollupStatus())
		case condition.RepoNameContainsRegex != "":
			conditionHolds = weightRule.regex.MatchString(codeReview.GetGithubFields().GetRepo().GetName())
		case condition.RepoOrgContainsRegex != "":
			conditionHolds = weightRule.regex.MatchString(codeReview.GetGithubFields().GetRepo().GetOrganizationName())
		case condition.ApprovedBySelf != nil:
			conditionHolds = *condition.ApprovedBySelf == codeReview.GetRenderOnlyFields().GetApprovedBySelf()
		case condition.ApprovedByOthers != nil:
			conditionHolds = *condition.ApprovedByOthers == codeReview.GetRenderOnlyFields().GetApprovedByOthers()
		}

		if conditionHolds {
			weight += weightRule.rule.WeightChange
		}
	}

	return weight
}

// compileWeightRules validates the configured weight rules and compiles their regular expressions. This happens
// at startup so that an invalid configuration is reported immediately instead of on every read of code reviews.
func compileWeightRules(weightRules []*proto.WeightRule) ([]compiledWeightRule, error) {
	ret := make([]compiledWeightRule, 0, len(weightRules))

	for index, weightRule := range weightRules {
		condition := weightRule.GetCondition()
		if condition == nil {
			return nil, fmt.Errorf("weight rule at index %d has no condition", index)
		}

		numConditions := 0
		regexPattern := ""
		for _, pattern := range []string{
			condition.AuthorContainsRegex,
			condition.CodeReviewTitleContainsRegex,
			condition.GithubPrPipelineStatusRegex,
			condition.RepoNameContainsRegex,
			condition.RepoOrgContainsRegex,
		} {
			if pattern != "" {
				numConditions++
				regexPattern = pattern
			}
		}
		if condition.ApprovedBySelf != nil {
			numConditions++
		}
		if condition.ApprovedByOthers != nil {
			numConditions++
		}

		if numConditions == 0 {
			return nil, fmt.Errorf("weight rule at index %d uses no condition", index)
		}
		if numConditions > 1 {
			return nil, fmt.Errorf("weight rule at index %d must only use one condition (no `AND` support)", index)
		}

		var regex *regexp.Regexp
		if regexPattern != "" {
			var err error
			regex, err = regexp.Compile(regexPattern)
			if err != nil {
				return nil, fmt.Errorf("weight rule at index %d uses invalid regular expression %q: %w", index, regexPattern, err)
			}
		}

		ret = append(ret, compiledWeightRule{
			rule:  weightRule,
			regex: regex,
		})
	}

	return ret, nil
}
