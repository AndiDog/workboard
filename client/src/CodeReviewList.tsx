import { Component } from 'preact';
import {
  WorkboardClient,
  GetCodeReviewsQuery,
  GetCodeReviewsResponse,
} from './generated/workboard';
import { GrpcResult, makePendingGrpcResult, toGrpcResult } from './grpc';

type CodeReviewListState = {
  codeReviewsGrpcResult?: GrpcResult<GetCodeReviewsResponse>;
};

export default class CodeReviewList extends Component<{}, CodeReviewListState> {
  componentDidMount() {
    this.setState({ codeReviewsGrpcResult: makePendingGrpcResult() }, () => {
      let client = new WorkboardClient('https://localhost:16667');

      const thiz = this;
      client.GetCodeReviews(new GetCodeReviewsQuery(), null, (error, res) => {
        thiz.setState({
          codeReviewsGrpcResult: toGrpcResult(error, res),
        });
      });
    });
  }

  render() {
    return (
      <>
        <h2>CodeReviewList</h2>
        <ul>
          {this.state.codeReviewsGrpcResult?.ok &&
            this.state.codeReviewsGrpcResult.res.codeReviews.map(
              (codeReview) => (
                <li>
                  {codeReview.id}

                  {codeReview.hasGithubFields && (
                    <>
                      <br />
                      <a href={codeReview.githubFields.url}>GitHub PR</a>
                      (status: {codeReview.status})
                    </>
                  )}
                </li>
              ),
            )}
        </ul>
      </>
    );
  }
}
