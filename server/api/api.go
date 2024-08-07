package api

import (
	"context"
	"fmt"
	"log"

	"github.com/pkg/errors"

	"andidog.de/workboard/server/database"
	"andidog.de/workboard/server/proto"
)

type WorkboardServer struct {
	proto.UnimplementedWorkboardServer

	db *database.Database
}

func NewWorkboardServer(db *database.Database) (*WorkboardServer, error) {
	if db == nil {
		return nil, errors.New("db must not be nil")
	}
	return &WorkboardServer{
		db: db,
	}, nil
}

type PR struct {
	GitHubURL string `json:"githubUrl"`
}

func (s *WorkboardServer) GetCodeReviews(ctx context.Context, cmd *proto.GetCodeReviewsQuery) (*proto.GetCodeReviewsResponse, error) {
	log.Printf("GetCodeReviews")

	codeReviews := map[string]proto.CodeReview{}
	ok, err := s.db.Get("code_reviews", &codeReviews)
	if err != nil {
		return nil, err
	}
	fmt.Printf("code_reviews ok=%v code_reviews=%+v\n", ok, codeReviews)

	// Simulated values for now
	codeReviews["myid"] = proto.CodeReview{
		Id: "myid",
		GithubFields: &proto.GitHubPullRequestFields{
			Url: "https://bla",
		},
	}
	err = s.db.Set("code_reviews", &codeReviews)
	if err != nil {
		return nil, err
	}
	fmt.Printf("code_reviews value set fine\n")

	codeReviews = map[string]proto.CodeReview{}
	_, err = s.db.Get("code_reviews", &codeReviews)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get code reviews from database")
	}

	res := &proto.GetCodeReviewsResponse{}
	for _, codeReview := range codeReviews {
		res.CodeReviews = append(res.CodeReviews, &codeReview)
	}
	return res, nil
}

func (s *WorkboardServer) MarkReviewed(ctx context.Context, cmd *proto.MarkReviewedCommand) (*proto.CommandResponse, error) {
	log.Printf("MarkReviewed")

	var pr PR
	ok, err := s.db.Get("andi", &pr)
	if err != nil {
		return nil, err
	}
	fmt.Printf("ok=%v pr=%+v\n", ok, pr)

	pr.GitHubURL = "https://andi-test"
	err = s.db.Set("andi", &pr)
	if err != nil {
		return nil, err
	}
	fmt.Printf("value set fine\n")

	return &proto.CommandResponse{}, nil
}
