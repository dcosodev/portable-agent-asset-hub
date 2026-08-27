# SearchSkills200Response


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**items** | [**List[SearchSkills200ResponseItemsInner]**](SearchSkills200ResponseItemsInner.md) |  |

## Example

```python
from openapi_client.models.search_skills200_response import SearchSkills200Response

# TODO update the JSON string below
json = "{}"
# create an instance of SearchSkills200Response from a JSON string
search_skills200_response_instance = SearchSkills200Response.from_json(json)
# print the JSON string representation of the object
print(SearchSkills200Response.to_json())

# convert the object into a dict
search_skills200_response_dict = search_skills200_response_instance.to_dict()
# create an instance of SearchSkills200Response from a dict
search_skills200_response_from_dict = SearchSkills200Response.from_dict(search_skills200_response_dict)
```
[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
